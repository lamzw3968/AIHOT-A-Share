import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { enqueue, getBoss, QUEUES, retryReleasedReceiptJobs, stopBoss } from "@aihot/backend/jobs/queue";
import { recoverStaleWork, releaseReceipt } from "@aihot/backend/operations/recover";
import { BudgetExceededError, logicalKeyFor, paidRequest, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { expireProviderQuotaLeases } from "@aihot/backend/providers/provider-quotas";

const T = tag();
const secret = "fake-unknown-test-secret";
let mode: "drop" | "answer" = "drop";
let hits = 0;
const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    hits++;
    if (mode === "drop") return void req.socket.destroy();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
let parked: Array<{ id: string; start_after: Date }> = [];
before(async () => {
  await getBoss();
  parked = await sql`SELECT id, start_after FROM pgboss.job WHERE name = ${QUEUES.analyze} AND state IN ('created', 'retry')`;
  if (parked.length) await sql`UPDATE pgboss.job SET start_after = '2100-01-01' WHERE id = ANY(${parked.map((r) => r.id)}::uuid[])`;
});
after(async () => {
  await stopBoss();
  if (parked.length) await sql`UPDATE pgboss.job j SET start_after = old.start_after
    FROM jsonb_to_recordset(${sql.json(parked as never)}) AS old(id uuid, start_after timestamptz) WHERE j.id = old.id`;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
});

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "unknown recovery worker did not settle");
    await delay(20);
  }
}

// A separate Node process runs the production work() wrapper and actual pg-boss failure serializer.
// Restarting it cannot depend on any parent-held error or manually constructed job output.
async function worker() {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    import './tests/setup.ts';
    const { sql, closeDb } = await import('@aihot/backend/db');
    const { getBoss, work, QUEUES, stopBoss } = await import('@aihot/backend/jobs/queue');
    const { paidRequest } = await import('@aihot/backend/providers/receipts');
    const boss = await getBoss();
    await work(boss, QUEUES.analyze, { pollingIntervalSeconds: 0.5 }, async (data) => paidRequest({
      service: 'invariant-unknown-worker', purpose: 'invariant_unknown', subject: 'worker:' + data.articleId,
      identity: data, attemptTag: data.attemptTag,
      quota: { key: data.articleId, intervalMs: 0, maxInflight: 1, leaseMs: 60000 }
    }, async () => ({ response: await (await fetch(${JSON.stringify(endpoint)}, {
      method: 'POST', headers: { authorization: 'Bearer ${secret}' }, body: '{}'
    })).json() })));
    process.stdout.write('ready\\n');
    process.stdin.once('data', async () => { await stopBoss(); await closeDb(); process.exit(0); });
    process.stdin.resume();
  `], { cwd: process.cwd(), env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => { output += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { output += part; });
  const ended = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`unknown worker exited ${code}`)));
  });
  // Observe an early exit without leaking the child's potentially sensitive diagnostic output.
  void ended.catch(() => {});
  await waitFor(async () => output.includes("ready\n") || child.exitCode !== null);
  assert.equal(child.exitCode, null, "worker must start");
  return { stop: async () => { child.stdin.end("stop\n"); await ended; assert.ok(!output.includes(secret)); } };
}

for (const fault of ["network", "storage"] as const) test(`real zero-retry Worker retains ${fault} receiptId across restart and only resends after manual authorization`, async () => {
  const data = { articleId: `unknown-${fault}-${T}`, attemptTag: `manual:${T}` };
  const subject = `worker:${data.articleId}`;
  mode = fault === "network" ? "drop" : "answer";
  const before = hits;
  if (fault === "storage") {
    await sql.unsafe(`CREATE FUNCTION fail_unknown_response() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.subject = '${subject}' AND NEW.status = 'received' THEN RAISE EXCEPTION '${secret}'; END IF;
      RETURN NEW; END $$`);
    await sql`CREATE TRIGGER fail_unknown_response BEFORE UPDATE ON receipts FOR EACH ROW EXECUTE FUNCTION fail_unknown_response()`;
  }
  let active: Awaited<ReturnType<typeof worker>> | undefined;
  const id = await enqueue(QUEUES.analyze, data, { retryLimit: 0, singletonKey: data.articleId, priority: 17, retentionSeconds: 300 });
  assert.ok(id);
  const boss = await getBoss();
  try {
    active = await worker();
    await waitFor(async () => (await boss.getJobById(QUEUES.analyze, id))?.state === "failed");
    await active.stop(); active = undefined;
    const failed = (await boss.getJobById(QUEUES.analyze, id))!;
    assert.equal(failed.retryCount, failed.retryLimit, "there are zero automatic retries left");
    const [receipt] = await sql<{ id: number; status: string; error: string }[]>`SELECT id, status, error FROM receipts WHERE subject = ${subject}`;
    assert.ok(receipt);
    assert.equal(receipt.status, "unknown");
    assert.equal((failed.output as { receiptId: number }).receiptId, receipt.id, "first failure is associated without hand-built output");
    assert.ok(!JSON.stringify(failed.output).includes(secret));
    assert.ok(!receipt.error.includes(secret));
    const [firstAttempt] = await sql`SELECT status, error, finished_at FROM receipt_attempts WHERE receipt_id = ${receipt.id}`;
    assert.equal(firstAttempt!.status, "unknown");
    assert.ok(firstAttempt!.finished_at);
    assert.equal(hits - before, 1);
    await sql`UPDATE receipts SET updated_at = now() - interval '1 day' WHERE id = ${receipt.id}`;
    await sql`UPDATE provider_quota_leases SET expires_at = now() - interval '1 second' WHERE quota_key = ${data.articleId}`;
    assert.ok(await expireProviderQuotaLeases() >= 1);
    await recoverStaleWork();
    assert.equal((await boss.getJobById(QUEUES.analyze, id))?.state, "failed");
    // Historical automatic releases must not become authorization after upgrading/restarting.
    await sql`INSERT INTO audit_log (actor, action, subject, before, after)
      VALUES ('ops.recover', 'receipt.release', ${`receipt:${receipt.id}`}, '{"status":"unknown"}', '{"status":"failed","billed":null}')`;
    assert.equal(await retryReleasedReceiptJobs(), 0);
    active = await worker();
    await recoverStaleWork();
    assert.equal(hits - before, 1, "lease expiry, elapsed time and restart buy no second request");
    await assert.rejects(releaseReceipt(receipt.id, { billed: undefined as never, note: "missing billing decision" }, "test"), /billed/);
    await assert.rejects(releaseReceipt(receipt.id, { billed: false, note: " " }, "test"), /note/);
    await releaseReceipt(receipt.id, { billed: true, note: "mock bill checked; explicitly accept another billed attempt" }, "test");
    const [audit] = await sql`SELECT after FROM audit_log WHERE subject = ${`receipt:${receipt.id}`} AND actor = 'test'`;
    assert.equal(audit!.after.billed, true);
    assert.equal(audit!.after.resendAuthorized, true);
    assert.deepEqual((await sql`SELECT status, error, finished_at FROM receipt_attempts WHERE receipt_id = ${receipt.id}`)[0], firstAttempt);
    // The unknown attempt remains evidence; authorization alone sends nothing.
    assert.equal(hits - before, 1);
    if (fault === "storage") {
      await sql`DROP TRIGGER fail_unknown_response ON receipts`;
      await sql`DROP FUNCTION fail_unknown_response()`;
    }
    if (fault === "network") {
      // A second loss after authorization needs a new decision; the old audit is not a retry loop.
      await recoverStaleWork();
      await waitFor(async () => (await boss.getJobById(QUEUES.analyze, id))?.state === "failed");
      assert.equal(hits - before, 2);
      assert.equal(await retryReleasedReceiptJobs(), 0);
      // Manual authorization does not release account capacity retained by the second loss.
      await sql`UPDATE provider_quota_leases SET expires_at = now() - interval '1 second' WHERE quota_key = ${data.articleId}`;
      await expireProviderQuotaLeases();
      await releaseReceipt(receipt.id, { billed: false, note: "second mock attempt reconciled; authorize one new send" }, "test");
    }
    mode = "answer";
    await recoverStaleWork();
    await waitFor(async () => (await boss.getJobById(QUEUES.analyze, id))?.state === "completed");
    const resumed = (await boss.getJobById(QUEUES.analyze, id))!;
    assert.deepEqual(resumed.data, data);
    assert.equal(resumed.priority, failed.priority);
    assert.equal(resumed.singletonKey, failed.singletonKey);
    assert.equal(resumed.keepUntil.getTime(), failed.keepUntil.getTime());
    assert.equal(hits - before, fault === "network" ? 3 : 2);
    assert.equal(await retryReleasedReceiptJobs(), 0);
    const request = { service: "invariant-unknown-worker", purpose: "invariant_unknown", subject, identity: data, attemptTag: data.attemptTag };
    const cached = await paidRequest(request, async () => { throw new Error("must reuse paid answer"); });
    assert.equal(cached.receiptId, receipt.id);
    assert.equal(cached.reused, true);
    assert.deepEqual(cached.response, { ok: true });
    const attempts = await sql`SELECT status, attempt FROM receipt_attempts WHERE receipt_id = ${receipt.id} ORDER BY attempt`;
    assert.deepEqual([...attempts], fault === "network"
      ? [{ status: "unknown", attempt: 1 }, { status: "unknown", attempt: 2 }, { status: "received", attempt: 3 }]
      : [{ status: "unknown", attempt: 1 }, { status: "received", attempt: 2 }]);
  } finally {
    await active?.stop();
    if (fault === "storage") {
      await sql`DROP TRIGGER IF EXISTS fail_unknown_response ON receipts`;
      await sql`DROP FUNCTION IF EXISTS fail_unknown_response()`;
    }
  }
});

test("a failed unknown-status write still exposes a safe receiptId and stale recovery never authorizes resending", async () => {
  const request = { service: `invariant-unknown-save-${T}`, purpose: "invariant_unknown", identity: T };
  await sql.unsafe(`CREATE FUNCTION fail_unknown_status() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.service = '${request.service}' AND NEW.status = 'unknown' THEN RAISE EXCEPTION '${secret}'; END IF;
    RETURN NEW; END $$`);
  await sql`CREATE TRIGGER fail_unknown_status BEFORE UPDATE ON receipts FOR EACH ROW EXECUTE FUNCTION fail_unknown_status()`;
  let receiptId = 0;
  try {
    await assert.rejects(paidRequest(request, async () => { throw new Error(`Bearer ${secret} https://user:${secret}@invalid.test`); }), (error) => {
      assert.ok(error instanceof ReceiptUnknownError);
      receiptId = error.receiptId;
      assert.ok(!String(error).includes(secret));
      assert.equal(error.cause, undefined);
      return true;
    });
  } finally {
    await sql`DROP TRIGGER fail_unknown_status ON receipts`;
    await sql`DROP FUNCTION fail_unknown_status()`;
  }
  const [pending] = await sql`SELECT id, status FROM receipts WHERE logical_key = ${logicalKeyFor(request)}`;
  assert.equal(receiptId, pending!.id);
  assert.equal(pending!.status, "pending");
  await sql`UPDATE receipts SET updated_at = now() - interval '11 minutes' WHERE id = ${receiptId}`;
  await recoverStaleWork();
  await assert.rejects(paidRequest(request, async () => { throw new Error("must not send"); }), ReceiptUnknownError);
  assert.equal((await sql`SELECT status FROM receipts WHERE id = ${receiptId}`)[0]!.status, "unknown");
});

test("an already queued legacy automatic release is blocked by the upgraded Worker until manually authorized", async () => {
  const data = { articleId: `legacy-unknown-${T}`, attemptTag: `legacy:${T}` };
  const request = { service: "invariant-unknown-worker", purpose: "invariant_unknown", subject: `worker:${data.articleId}`, identity: data, attemptTag: data.attemptTag };
  const legacyNote = "自动放行：结果未知超过 30 分钟，未核对是否计费";
  const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts (logical_key, service, purpose, subject, status, attempts, error)
    VALUES (${logicalKeyFor(request)}, ${request.service}, ${request.purpose}, ${request.subject}, 'failed', 1, ${legacyNote}) RETURNING id`;
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, status, error)
    VALUES (${receipt!.id}, 1, ${request.service}, 'failed', ${legacyNote})`;
  await sql`INSERT INTO audit_log (actor, action, subject, before, after)
    VALUES ('ops.recover', 'receipt.release', ${`receipt:${receipt!.id}`}, '{"status":"unknown"}', '{"status":"failed","billed":null}')`;
  const before = hits;
  const id = await enqueue(QUEUES.analyze, data, { retryLimit: 0, singletonKey: data.articleId });
  assert.ok(id);
  mode = "answer";
  const active = await worker();
  const boss = await getBoss();
  try {
    await waitFor(async () => (await boss.getJobById(QUEUES.analyze, id))?.state === "failed");
    assert.equal(hits, before, "the old automatic release does not buy a request on restart");
    assert.equal((await sql`SELECT status FROM receipts WHERE id = ${receipt!.id}`)[0]!.status, "unknown");
    assert.equal(((await boss.getJobById(QUEUES.analyze, id))!.output as { receiptId: number }).receiptId, receipt!.id);
    assert.deepEqual((await sql`SELECT status, error FROM receipt_attempts WHERE receipt_id = ${receipt!.id}`)[0], { status: "failed", error: legacyNote });
    await releaseReceipt(receipt!.id, { billed: false, note: "legacy outcome checked; explicitly authorize resend" }, "test");
    await recoverStaleWork();
    await waitFor(async () => (await boss.getJobById(QUEUES.analyze, id))?.state === "completed");
    assert.equal(hits, before + 1);
    assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE subject = ${`receipt:${receipt!.id}`}`)[0]!.n, 2, "legacy audit remains alongside the new authorization");
  } finally { await active.stop(); }
});

test("manual unknown authorization cannot bypass the paid-attempt budget", async () => {
  const service = `unknown-budget-${T}`;
  const request = { service, purpose: "invariant_unknown", identity: T };
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, 1, 1, 1)`;
  let sends = 0;
  try {
    await assert.rejects(paidRequest(request, async () => { sends++; throw new Error(secret); }), ReceiptUnknownError);
    const [receipt] = await sql<{ id: number }[]>`SELECT id FROM receipts WHERE logical_key = ${logicalKeyFor(request)}`;
    await releaseReceipt(receipt!.id, { billed: true, note: "mock billed attempt checked; authorize retry subject to budget" }, "test");
    await assert.rejects(paidRequest(request, async () => { sends++; return { response: {} }; }), BudgetExceededError);
    assert.equal(sends, 1);
    assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE receipt_id = ${receipt!.id}`)[0]!.n, 1);
    assert.equal((await sql`SELECT status FROM receipts WHERE id = ${receipt!.id}`)[0]!.status, "failed", "authorization remains available after budget denial");
  } finally { await sql`DELETE FROM budgets WHERE service = ${service}`; }
});
