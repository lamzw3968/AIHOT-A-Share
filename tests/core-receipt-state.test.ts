import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { sql, closeDb, type Tx } from "@aihot/backend/db";
import { paidRequest, logicalKeyFor, markStalePendingReceipts, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
after(closeDb);

test("stale recovery waiting on a response transaction preserves its committed answer and attempt", async () => {
  const request = { service: "invariant-recovery-race", purpose: "invariant_test", identity: { race: tag() } };
  const asked = gate();
  const answer = gate();
  let sent = 0;
  const first = paidRequest(request, async () => {
    sent += 1;
    asked.open();
    await answer.promise;
    return { response: { saved: true } };
  });
  await asked.promise;
  const [row] = await sql<{ id: number }[]>`SELECT id FROM receipts WHERE logical_key = ${logicalKeyFor(request)}`;
  await sql`UPDATE receipts SET updated_at = now() - interval '11 minutes' WHERE id = ${row!.id}`;

  // Hold only the attempt row: paidRequest can write its received response, but cannot commit yet.
  const locked = gate();
  const release = gate();
  const blocker = sql.begin(async (tx) => {
    await tx`SELECT id FROM receipt_attempts WHERE receipt_id = ${row!.id} FOR UPDATE`;
    locked.open();
    await release.promise;
  });
  await locked.promise;
  const waitingOn = async (query: string) => {
    for (let i = 0; i < 500; i++) {
      const waiting = await sql`SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${query}`;
      if (waiting.length) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`transaction never waited on ${query}`);
  };
  let sweep: Promise<number> | undefined;
  try {
    answer.open();
    await waitingOn("%UPDATE receipt_attempts SET%");
    sweep = markStalePendingReceipts();
    await waitingOn("%UPDATE receipts SET status =%");
  } finally {
    release.open();
    await blocker;
  }
  await first;
  assert.equal(await sweep, 0, "a completed response no longer counts as stale pending");
  const again = await paidRequest(request, async () => {
    sent += 1;
    return { response: { saved: false } };
  });
  assert.equal(sent, 1);
  assert.equal(again.reused, true);
  assert.deepEqual(again.response, { saved: true });
  const [attempt] = await sql<{ status: string }[]>`SELECT status FROM receipt_attempts WHERE receipt_id = ${row!.id}`;
  assert.equal(attempt!.status, "received");
});

function loseResponseCommitAcknowledgement(t: TestContext, afterCommit: () => Promise<void> = async () => {}) {
  const begin = sql.begin.bind(sql);
  let transactions = 0;
  return t.mock.method(sql, "begin", (async (callback: (tx: Tx) => Promise<unknown>) => {
    const result = await begin(callback);
    if (++transactions === 2) {
      await afterCommit();
      throw new Error("simulated lost acknowledgement after real commit");
    }
    return result;
  }) as typeof sql.begin);
}

test("a lost commit acknowledgement immediately reuses the durable received answer", async (t) => {
  const request = { service: "invariant-commit-ack", purpose: "invariant_test", identity: tag(),
    quota: { key: `commit-ack-${tag()}`, intervalMs: 0, maxInflight: 1, leaseMs: 60_000 } };
  let sent = 0;
  const at = new Date("2026-10-01T00:00:00.000Z");
  const injected = loseResponseCommitAcknowledgement(t);
  let receiptId: number;
  try {
    const result = await paidRequest(request, async () => { sent++; return { response: { saved: true, at } }; });
    receiptId = result.receiptId;
    assert.equal(result.reused, true);
    assert.deepEqual(result.response, { saved: true, at: at.toISOString() }, "use the persisted JSON, not the in-memory outcome");
  } finally { injected.mock.restore(); }
  const [row] = await sql`SELECT r.status, r.response, r.received_at IS NOT NULL AS received,
    a.status AS attempt_status, a.finished_at IS NOT NULL AS finished FROM receipts r
    JOIN receipt_attempts a ON a.receipt_id = r.id WHERE r.id = ${receiptId}`;
  assert.deepEqual(row, { status: "received", response: { saved: true, at: at.toISOString() }, received: true, attempt_status: "received", finished: true });
  assert.equal((await sql`SELECT 1 FROM provider_quota_leases WHERE quota_key=${request.quota.key}`).length, 0,
    "the same committed response transaction releases its quota lease");
  const cached = await paidRequest(request, async () => { sent++; return { response: { saved: false } }; });
  assert.equal(sent, 1);
  assert.equal(cached.reused, true);
  assert.equal(cached.receiptId, receiptId);
  assert.deepEqual(cached.response, { saved: true, at: at.toISOString() });
  assert.equal((await sql`SELECT 1 FROM receipt_attempts WHERE receipt_id=${receiptId}`).length, 1);
});

test("a completed receipt with a finished received attempt also survives a lost acknowledgement", async (t) => {
  const request = { service: "invariant-completed-ack", purpose: "invariant_test", identity: tag() };
  const injected = loseResponseCommitAcknowledgement(t, async () => {
    await sql`UPDATE receipts SET status='completed',completed_at=now() WHERE logical_key=${logicalKeyFor(request)}`;
  });
  let sent = 0;
  try {
    const result = await paidRequest(request, async () => { sent++; return { response: { complete: true } }; });
    assert.equal(result.reused, true);
    assert.deepEqual(result.response, { complete: true });
    assert.equal((await sql`SELECT status FROM receipts WHERE id=${result.receiptId}`)[0]!.status, "completed");
    assert.equal(sent, 1);
  } finally { injected.mock.restore(); }
});

test("a real response transaction rollback remains unknown and cannot send another request", async (t) => {
  const request = { service: "invariant-rolled-back-response", purpose: "invariant_test", identity: tag(),
    quota: { key: `rollback-${tag()}`, intervalMs: 0, maxInflight: 1, leaseMs: 60_000 } };
  const begin = sql.begin.bind(sql);
  let transactions = 0;
  const injected = t.mock.method(sql, "begin", (async (callback: (tx: Tx) => Promise<unknown>) => begin(async (tx) => {
    const result = await callback(tx);
    if (++transactions === 2) await tx.unsafe("SELECT 1 / 0"); // PostgreSQL aborts and rolls back the real response transaction.
    return result;
  })) as typeof sql.begin);
  let sent = 0;
  let receiptId = 0;
  try {
    await assert.rejects(paidRequest(request, async () => { sent++; return { response: { saved: true } }; }), (error) => {
      assert.ok(error instanceof ReceiptUnknownError);
      receiptId = error.receiptId;
      assert.equal(error.cause, undefined);
      return true;
    });
  } finally { injected.mock.restore(); }
  const [row] = await sql`SELECT r.status,r.response,r.received_at,a.status AS attempt_status,a.finished_at IS NOT NULL AS finished
    FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id WHERE r.id=${receiptId}`;
  assert.deepEqual(row, { status: "unknown", response: null, received_at: null, attempt_status: "unknown", finished: true });
  await assert.rejects(paidRequest(request, async () => { sent++; return { response: { saved: false } }; }), ReceiptUnknownError);
  assert.equal(sent, 1);
  assert.equal((await sql`SELECT 1 FROM receipt_attempts WHERE receipt_id=${receiptId}`).length, 1);
  assert.equal((await sql`SELECT 1 FROM provider_quota_leases WHERE quota_key=${request.quota.key}`).length, 1,
    "rolling back the response transaction must retain the unknown request's lease");
});

test("failure to confirm a committed response remains conservatively unknown", async (t) => {
  const request = { service: "invariant-confirmation-failure", purpose: "invariant_test", identity: tag() };
  const begin = sql.begin.bind(sql);
  let transactions = 0;
  let confirmationFailed = false;
  const injected = t.mock.method(sql, "begin", (async (callback: (tx: Tx) => Promise<unknown>) => {
    const current = ++transactions;
    const result = await begin(async (tx) => {
      const checked = current === 3 ? new Proxy(tx, {
        apply(target, thisArg, args) {
          if (Array.isArray(args[0]) && args[0].join("").includes("SELECT r.response FROM receipts r")) {
            confirmationFailed = true;
            return tx.unsafe("SELECT 1 / 0"); // A real PostgreSQL error rolls back the confirmation transaction.
          }
          return Reflect.apply(target, thisArg, args);
        },
      }) : tx;
      return callback(checked);
    });
    if (current === 2) throw new Error("simulated lost acknowledgement after real commit");
    return result;
  }) as typeof sql.begin);
  let sent = 0;
  let receiptId = 0;
  try {
    await assert.rejects(paidRequest(request, async () => { sent++; return { response: { saved: true } }; }), (error) => {
      assert.ok(error instanceof ReceiptUnknownError);
      receiptId = error.receiptId;
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.message, /division|acknowledgement/i);
      return true;
    });
  } finally { injected.mock.restore(); }
  assert.equal(confirmationFailed, true);
  assert.equal(sent, 1);
  const [row] = await sql`SELECT r.status,r.response,a.status AS attempt_status FROM receipts r
    JOIN receipt_attempts a ON a.receipt_id=r.id WHERE r.id=${receiptId}`;
  assert.deepEqual(row, { status: "received", response: { saved: true }, attempt_status: "received" });
});

for (const invalid of ["json-null", "sql-null", "missing-received-at", "unfinished-attempt", "unknown-attempt", "different-attempt", "unknown-receipt"] as const) {
  test(`lost acknowledgement cannot reuse an unconfirmed response: ${invalid}`, async (t) => {
    const request = { service: "invariant-unconfirmed-response", purpose: "invariant_test", identity: { run: tag(), invalid } };
    const injected = loseResponseCommitAcknowledgement(t, async () => {
      const [receipt] = await sql<{ id: number }[]>`SELECT id FROM receipts WHERE logical_key=${logicalKeyFor(request)}`;
      const id = receipt!.id;
      if (invalid === "sql-null") await sql`UPDATE receipts SET response=NULL WHERE id=${id}`;
      if (invalid === "missing-received-at") await sql`UPDATE receipts SET received_at=NULL WHERE id=${id}`;
      if (invalid === "unfinished-attempt") await sql`UPDATE receipt_attempts SET finished_at=NULL WHERE receipt_id=${id}`;
      if (invalid === "unknown-attempt") await sql`UPDATE receipt_attempts SET status='unknown' WHERE receipt_id=${id}`;
      if (invalid === "different-attempt") {
        await sql`UPDATE receipts SET attempts=2 WHERE id=${id}`;
        await sql`INSERT INTO receipt_attempts (receipt_id,attempt,service,status,finished_at)
          VALUES (${id},2,${request.service},'received',now())`;
      }
      if (invalid === "unknown-receipt") await sql`UPDATE receipts SET status='unknown' WHERE id=${id}`;
    });
    let sent = 0;
    try {
      await assert.rejects(paidRequest(request, async () => { sent++; return { response: invalid === "json-null" ? null : { saved: true } }; }), (error) => {
        assert.ok(error instanceof ReceiptUnknownError);
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(sent, 1, "confirmation failure must not invoke the provider a second time");
    } finally { injected.mock.restore(); }
  });
}
