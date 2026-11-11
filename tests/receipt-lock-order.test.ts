import { gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { sql, closeDb, type Tx } from "@aihot/backend/db";
import { chatJson } from "@aihot/backend/providers/llm";
import { lingQuota } from "@aihot/backend/providers/model-profile";

after(closeDb);

// The comparison below intentionally creates a real deadlock. Restrict it to a local,
// explicitly named throwaway database, in addition to the shared test setup's name guard.
const database = new URL(process.env.DATABASE_URL!);
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(database.hostname)) {
  throw new Error("receipt lock-order tests require a loopback PostgreSQL database");
}

async function waitForBlocked(pid: number, blocker: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [row] = await sql<{ blocked: boolean }[]>`
      SELECT ${blocker} = ANY(pg_blocking_pids(${pid})) AS blocked`;
    if (row!.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`PostgreSQL backend ${pid} did not wait for backend ${blocker}`);
}

async function waitForAnyBlockedBy(blocker: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await sql<{ pid: number }[]>`
      SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> ${blocker}
        AND ${blocker} = ANY(pg_blocking_pids(pid))`;
    if (rows.length) return rows[0]!.pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no PostgreSQL backend waited for response backend ${blocker}`);
}

async function withDeadline<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 5000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

test("the previous candidate-first order forms a real PostgreSQL deadlock", { timeout: 15_000 }, async () => {
  const unique = tag();
  const service = `lock-order-old-${unique}`;
  const quota = `lock-order-old-${unique}`;
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, model, purpose, status, request, attempts)
    VALUES (${unique}, ${service}, 'ling', 'test', 'pending', '{}'::jsonb, 1) RETURNING id`;
  await sql`INSERT INTO provider_quotas (quota_key) VALUES (${quota})`;
  const candidateLocked = gate<number>();
  const quotaLocked = gate<number>();
  const requestQuota = gate();
  const updateReceipt = gate();
  // These are the conflicting statements from the previous admission and response paths.
  // Distinct transactions/connection PIDs are observed with pg_blocking_pids below.
  const admission = sql.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout = '8s'`;
    const [pid] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await tx`SELECT r.id FROM receipts r WHERE r.service = ${service} AND r.model = 'ling'
      AND r.purpose = 'test' AND r.status IN ('pending', 'unknown') ORDER BY r.id FOR UPDATE OF r`;
    candidateLocked.open(pid!.pid);
    await requestQuota.promise;
    await tx`SELECT quota_key FROM provider_quotas WHERE quota_key = ${quota} FOR UPDATE`;
  });
  const response = sql.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout = '8s'`;
    const [pid] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await tx`SELECT quota_key FROM provider_quotas WHERE quota_key = ${quota} FOR UPDATE`;
    quotaLocked.open(pid!.pid);
    await updateReceipt.promise;
    await tx`UPDATE receipts SET status = 'received' WHERE id = ${row!.id}`;
  });
  // Attach rejection handlers immediately: one transaction is deliberately a deadlock victim.
  const outcomes = Promise.allSettled([admission, response]);
  try {
    const [admissionPid, responsePid] = await withDeadline(Promise.all([candidateLocked.promise, quotaLocked.promise]), "both old-order locks");
    assert.notEqual(admissionPid, responsePid);
    requestQuota.open();
    await waitForBlocked(admissionPid, responsePid);
    updateReceipt.open();
    const results = await outcomes;
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(errors.length, 1);
    assert.equal((errors[0]!.reason as { code?: string }).code, "40P01", "PostgreSQL detected the old lock cycle");
  } finally {
    requestQuota.open();
    updateReceipt.open();
    await outcomes;
  }
});

test("a response and an unrelated default-tag Ling admission cannot form the old lock cycle", { timeout: 20_000 }, async (t) => {
  const unique = tag();
  const purpose = `lock_order_${unique}`;
  const a = `A-${unique}`;
  const b = `B-${unique}`;
  const asked = gate();
  const answer = gate();
  const quotaHeld = gate<number>();
  const continueResponse = gate();
  const provider = await stub(async (_hit, request) => {
    if (request.body.includes(a)) {
      asked.open();
      await answer.promise;
    }
    return { choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }] };
  });
  t.after(() => provider.close());
  const apiKey = `dummy-ling-${unique}`;
  Object.assign(process.env, { ANT_LING_BASE_URL: provider.url, ANT_LING_API_KEY: apiKey,
    ANT_LING_QPS: "1000", ANT_LING_MAX_INFLIGHT: "2" });
  const quota = lingQuota(provider.url, apiKey, 85_000);
  const ask = (subject: string) => chatJson({ model: "ling-3.1-flash", purpose, subject, promptVersion: "v1",
    system: "test prompt", user: `article ${subject}`, schema: z.object({ ok: z.boolean() }), maxTokens: 512 });
  const first = ask(a);
  const firstHandled = first.then(() => undefined, () => undefined);
  let second: ReturnType<typeof ask> | undefined;
  try {
    await withDeadline(asked.promise, "the first provider call");
  } catch (error) {
    answer.open();
    await firstHandled;
    throw error;
  }

  // Pause the real response transaction only AFTER it acquires its real quota row lock.
  // The second real paidRequest must then wait without owning the first receipt's row lock.
  const begin = sql.begin.bind(sql);
  let intercepted = false;
  const injected = t.mock.method(sql, "begin", (async (callback: (tx: Tx) => Promise<unknown>) => begin(async (tx) => {
    const checked = new Proxy(tx, {
      apply(target, thisArg, args) {
        const query = Array.isArray(args[0]) ? args[0].join("") : "";
        if (!intercepted && query.includes("SELECT quota_key FROM provider_quotas") && query.includes("FOR UPDATE")) {
          intercepted = true;
          return (async () => {
            const result = await Reflect.apply(target, thisArg, args);
            const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            quotaHeld.open(row!.pid);
            await continueResponse.promise;
            return result;
          })();
        }
        return Reflect.apply(target, thisArg, args);
      },
    });
    return callback(checked);
  })) as typeof sql.begin);
  try {
    answer.open();
    const responsePid = await withDeadline(quotaHeld.promise, "the response quota lock");
    second = ask(b);
    // A rejected admission must not become an unhandled rejection while observing PostgreSQL.
    void second.catch(() => {});
    const admissionPid = await waitForAnyBlockedBy(responsePid);
    assert.notEqual(admissionPid, responsePid);
    continueResponse.open();
    const [resultA, resultB] = await Promise.all([first, second]);
    assert.equal(resultA.reused, false);
    assert.equal(resultB.reused, false);
    assert.notEqual(resultA.receiptId, resultB.receiptId);
  } finally {
    answer.open();
    continueResponse.open();
    await firstHandled;
    if (second) await second.catch(() => {});
    injected.mock.restore();
  }
  const againA = await ask(a);
  const againB = await ask(b);
  assert.equal(againA.reused, true);
  assert.equal(againB.reused, true);
  assert.equal(provider.hits(), 2, "one provider call per independent request, including cache rechecks");
  const rows = await sql<{ logical_key: string; status: string; attempts: number; attempt_status: string; finished: boolean }[]>`
    SELECT r.logical_key, r.status, r.attempts, a.status AS attempt_status, a.finished_at IS NOT NULL AS finished
    FROM receipts r JOIN receipt_attempts a ON a.receipt_id = r.id
    WHERE r.purpose = ${purpose} AND r.subject IN (${a}, ${b}) ORDER BY r.id`;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.status, "received");
    assert.equal(row.attempts, 1);
    assert.equal(row.attempt_status, "received");
    assert.equal(row.finished, true);
  }
  assert.equal((await sql`SELECT id FROM provider_quota_leases WHERE quota_key = ${quota.key}`).length, 0);
  assert.equal((await sql`SELECT quota_key FROM provider_quotas WHERE quota_key = ${quota.key}`).length, 1);
});
