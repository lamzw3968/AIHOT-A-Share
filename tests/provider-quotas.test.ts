import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { BudgetExceededError, completeReceipt, logicalKeyFor, paidRequest, ProviderRejectedError, ReceiptBusyError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { claimProviderQuota, coolDownProviderQuota, expireProviderQuotaLeases, finishProviderQuota, ProviderDeferredError, providerQuotaKey, retryAfterSeconds, type ProviderQuota } from "@aihot/backend/providers/provider-quotas";

const T = tag();
const service = `quota-test-${T}`;
const quota = (suffix: string): ProviderQuota => ({ key: providerQuotaKey("ant-ling", "http://127.0.0.1/v1", `dummy-${T}-${suffix}`), intervalMs: 1000, maxInflight: 1, leaseMs: 100_000 });
const request = (id: string, q: ProviderQuota) => ({ service, purpose: "quota-test", subject: `${T}-${id}`, identity: { test: T, id }, quota: q });
const answer = async () => ({ response: { ok: true } });
after(closeDb);

test("quota aliases share a secret-free key, account groups merge keys and endpoints explicitly", () => {
  const a = providerQuotaKey("ant-ling", "https://api.ant-ling.com/v1/", "dummy-private-key");
  assert.equal(a, providerQuotaKey("ant-ling", "https://api.ant-ling.com/v1", "dummy-private-key"));
  assert.notEqual(a, providerQuotaKey("ant-ling", "https://api.ant-ling.com/v1", "dummy-another-key"));
  assert.equal(providerQuotaKey("ant-ling", "https://api.ant-ling.com/v1", "dummy-key-a", "account-a"),
    providerQuotaKey("ant-ling", "http://127.0.0.1/v1", "dummy-key-b", "account-a"));
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.ok(!a.includes("private"));
  assert.notEqual(a, providerQuotaKey("ant-ling", "https://api.ant-ling.com/v2", "dummy-private-key"));
  assert.notEqual(providerQuotaKey("ant-ling", "https://api.ant-ling.com/v1", "dummy-key", "account-a"),
    providerQuotaKey("another-provider", "https://api.ant-ling.com/v1", "dummy-key", "account-a"));
});

test("Retry-After parses seconds and HTTP dates, rejecting ambiguous and invalid values", () => {
  const now = Date.UTC(2026, 9, 10, 0, 0, 0);
  assert.equal(retryAfterSeconds("12", now), 12);
  assert.equal(retryAfterSeconds("0.5", now), 1);
  assert.equal(retryAfterSeconds(new Date(now + 40_000).toUTCString(), now), 40);
  assert.equal(retryAfterSeconds(new Date(now - 40_000).toUTCString(), now), 0);
  assert.equal(retryAfterSeconds(" 12 ", now), 12);
  for (const value of [null, "", "-1", "2026", "soon", "Infinity", "1e3", "99999999999999999999", "Sat, 31 Feb 2026 00:00:00 GMT"]) {
    if (value === "2026") assert.equal(retryAfterSeconds(value, now), 2026);
    else assert.equal(retryAfterSeconds(value, now), undefined);
  }
});

test("waiting does not create a receipt/attempt, and a cached result bypasses quotas and budgets", async () => {
  const q = quota("cache");
  const req = request("cached", q);
  const first = await paidRequest(req, answer);
  await sql`UPDATE provider_quotas SET cooldown_until = now() + interval '1 hour' WHERE quota_key = ${q.key}`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, 0, 0, 0)`;
  try {
    assert.equal((await paidRequest(req, () => { throw new Error("must reuse"); })).receiptId, first.receiptId);
    await assert.rejects(paidRequest(request("budget", q), answer), BudgetExceededError);
  } finally { await sql`DELETE FROM budgets WHERE service = ${service}`; }
  const waiting = request("waiting", q);
  await assert.rejects(paidRequest(waiting, answer), (error) => error instanceof ProviderDeferredError && error.retryAfterSeconds > 3500);
  const [counts] = await sql<{ receipts: number; attempts: number }[]>`
    SELECT (SELECT count(*)::int FROM receipts WHERE subject = ${waiting.subject}) AS receipts,
      (SELECT count(*)::int FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id WHERE r.subject = ${waiting.subject}) AS attempts`;
  assert.deepEqual(counts, { receipts: 0, attempts: 0 });
});

test("unknown calls retain capacity until lease expiry without releasing their logical receipt", async () => {
  const q = quota("unknown");
  const req = request("unknown", q);
  await assert.rejects(paidRequest(req, () => Promise.reject(new Error("unknown network outcome"))), /unknown network/);
  await assert.rejects(paidRequest(req, answer), ReceiptUnknownError);
  await assert.rejects(paidRequest(request("other-during-unknown", q), answer), ProviderDeferredError);
  const [lease] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM provider_quota_leases WHERE quota_key = ${q.key}`;
  assert.equal(lease!.n, 1);
  await sql`UPDATE provider_quota_leases SET expires_at = now() - interval '1 second' WHERE quota_key = ${q.key}`;
  await sql`UPDATE provider_quotas SET next_start_at = 'epoch' WHERE quota_key = ${q.key}`;
  await paidRequest(request("after-lease-expiry", q), answer);
  await assert.rejects(paidRequest(req, answer), ReceiptUnknownError);
});

test("real 429 counts one attempt and shares Retry-After/capped exponential cooldown", async () => {
  const q = quota("429");
  for (const [i, supplied] of [45, undefined, undefined, undefined, undefined, undefined].entries()) {
    if (i) await sql`UPDATE provider_quotas SET cooldown_until = 'epoch', next_start_at = 'epoch' WHERE quota_key = ${q.key}`;
    let delay = -1;
    await assert.rejects(paidRequest(request(`429-${i}`, q), async () => {
      throw new ProviderRejectedError("stub HTTP 429", 429, true, supplied);
    }), (error) => { assert.ok(error instanceof ProviderRejectedError); delay = error.retryAfterSeconds!; return true; });
    if (supplied !== undefined) assert.equal(delay, supplied);
    else assert.ok(delay >= Math.min(300, 30 * 2 ** i) && delay <= 300);
    await assert.rejects(paidRequest(request(`429-wait-${i}`, q), answer), ProviderDeferredError);
  }
  const [counts] = await sql<{ receipts: number; attempts: number }[]>`
    SELECT (SELECT count(*)::int FROM receipts WHERE subject LIKE ${`${T}-429-%`}) AS receipts,
      (SELECT count(*)::int FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id WHERE r.subject LIKE ${`${T}-429-%`}) AS attempts`;
  assert.deepEqual(counts, { receipts: 6, attempts: 6 });
});

test("inflight callbacks hold neither a transaction nor a checked-out database connection", async () => {
  const q = quota("inflight");
  const admitted = gate();
  const finish = gate();
  const first = paidRequest(request("inflight-first", q), async () => { admitted.open(); await finish.promise; return answer(); });
  await admitted.promise;
  try {
    await assert.rejects(paidRequest(request("inflight-second", q), answer), ProviderDeferredError);
    // The quota row can be locked while the provider is still pending.
    await sql.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '1s'`;
      await tx`SELECT quota_key FROM provider_quotas WHERE quota_key = ${q.key} FOR UPDATE`;
    });
  } finally { finish.open(); await first; }
});

test("two independent Node processes share the same admission lease", async () => {
  const q = quota("processes");
  function child(id: string, hold: boolean) {
    const code = `
      await import('./tests/setup.ts');
      const { paidRequest } = await import('@aihot/backend/providers/receipts');
      const { ProviderDeferredError } = await import('@aihot/backend/providers/provider-quotas');
      const { closeDb } = await import('@aihot/backend/db');
      try {
        await paidRequest(${JSON.stringify(request(id, q))}, async () => {
          process.stdout.write('admitted\\n');
          ${hold ? "await new Promise(resolve => process.stdin.once('data', resolve));" : ""}
          return { response: { ok: true } };
        });
        process.stdout.write('finished\\n');
      } catch (error) {
        process.stdout.write(error instanceof ProviderDeferredError ? 'deferred\\n' : 'unexpected\\n');
        if (!(error instanceof ProviderDeferredError)) process.exitCode = 1;
      } finally { await closeDb(); }
    `;
    const processChild = spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd: path.resolve(import.meta.dirname, ".."), env: process.env, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    processChild.stdout.setEncoding("utf8").on("data", (part: string) => { output += part; });
    processChild.stderr.resume();
    const ended = new Promise<void>((resolve, reject) => {
      processChild.once("error", reject);
      processChild.once("exit", (status) => status === 0 ? resolve() : reject(new Error(`quota child exited ${status}`)));
    });
    return { processChild, ended, output: () => output };
  }
  const first = child("process-first", true);
  try {
    for (let n = 0; !first.output().includes("admitted") && n < 100; n++) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(first.output().includes("admitted"));
    const second = child("process-second", false);
    await second.ended;
    assert.equal(second.output(), "deferred\n");
  } finally { first.processChild.stdin.end("release\n"); await first.ended; }
  const [attempts] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id WHERE r.subject IN (${`${T}-process-first`}, ${`${T}-process-second`})`;
  assert.equal(attempts!.n, 1);
});

test("different quota groups remain independent while two live leases consume one group", async () => {
  const q = { ...quota("parallel-group"), intervalMs: 0, maxInflight: 2 };
  const other = { ...quota("independent-group"), intervalMs: 0 };
  const admitted = gate();
  const finish = gate();
  let active = 0;
  const held = async () => { if (++active === 2) admitted.open(); await finish.promise; return answer(); };
  const first = paidRequest(request("parallel-first", q), held);
  const second = paidRequest(request("parallel-second", q), held);
  await admitted.promise;
  try {
    const [leases] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM provider_quota_leases WHERE quota_key = ${q.key}`;
    assert.equal(leases!.n, 2);
    let sent = 0;
    await assert.rejects(paidRequest(request("parallel-third", q), async () => { sent++; return answer(); }), ProviderDeferredError);
    assert.equal(sent, 0);
    await paidRequest(request("independent", other), answer);
  } finally { finish.open(); await Promise.all([first, second]); }
  const [remaining] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM provider_quota_leases WHERE quota_key = ${q.key}`;
  assert.equal(remaining!.n, 0, "each known response releases its own lease");
});

test("a deferred retry preserves a failed receipt, attempts, error and timestamps", async () => {
  const q = quota("failed-retry");
  const req = request("failed-retry", q);
  let sent = 0;
  await assert.rejects(paidRequest(req, async () => { sent++; throw new ProviderRejectedError("stub rejection", 503, true); }), ProviderRejectedError);
  await sql`UPDATE provider_quotas SET cooldown_until = now() + interval '1 hour' WHERE quota_key = ${q.key}`;
  const before = await sql`SELECT status, attempts, error, updated_at FROM receipts WHERE subject = ${req.subject}`;
  await assert.rejects(paidRequest(req, async () => { sent++; return answer(); }), ProviderDeferredError);
  const after = await sql`SELECT status, attempts, error, updated_at FROM receipts WHERE subject = ${req.subject}`;
  assert.deepEqual([...after], [...before]);
  const attempts = await sql`SELECT status, attempt FROM receipt_attempts WHERE receipt_id = (SELECT id FROM receipts WHERE subject = ${req.subject})`;
  assert.deepEqual([...attempts], [{ status: "failed", attempt: 1 }]);
  assert.equal(sent, 1);
});

test("quota policy changes preserve logical identity, saved metadata and completed cache reuse", async () => {
  const q = { ...quota("policy-cache"), intervalMs: 0 };
  const req = { ...request("policy-cache", q), model: "dummy-model", attemptTag: "explicit-rerun", requestSummary: { safe: true } };
  const { quota: _quota, ...withoutQuota } = req;
  assert.equal(logicalKeyFor(req), logicalKeyFor(withoutQuota));
  assert.equal(logicalKeyFor(req), logicalKeyFor({ ...req, quota: { ...q, intervalMs: 5000, maxInflight: 3 } }));
  assert.notEqual(logicalKeyFor(req), logicalKeyFor({ ...req, attemptTag: "next-rerun" }));
  const outcome = { response: { ok: true, raw: [1, "answer"] }, requestId: "dummy-request-id", usage: { total_tokens: 12 }, cost: { amount: 0.25, currency: "USD", basis: "actual" as const } };
  const first = await paidRequest(withoutQuota, async () => outcome);
  await completeReceipt(sql, first.receiptId);
  const cached = await paidRequest({ ...req, quota: { ...q, maxInflight: 0 } }, () => { throw new Error("cache must bypass admission"); });
  assert.equal(cached.receiptId, first.receiptId);
  assert.equal(cached.reused, true);
  assert.deepEqual(cached.response, outcome.response);
  const [row] = await sql`SELECT r.status, r.request, r.request_id, r.usage, r.cost, r.currency, r.cost_basis, a.usage AS attempt_usage
    FROM receipts r JOIN receipt_attempts a ON a.receipt_id = r.id WHERE r.id = ${first.receiptId}`;
  assert.deepEqual(row, { status: "completed", request: { safe: true }, request_id: "dummy-request-id", usage: outcome.usage,
    cost: 0.25, currency: "USD", cost_basis: "actual", attempt_usage: outcome.usage });
  const [state] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM provider_quotas WHERE quota_key = ${q.key}`;
  assert.equal(state!.n, 0, "neither no-quota requests nor cached responses touch the quota tables");
});

test("without quota a real 429 retains its original error and failed-attempt behavior", async () => {
  const { quota: _quota, ...req } = request("no-quota-429", quota("unused"));
  const rejection = new ProviderRejectedError("stub HTTP 429", 429, true);
  let sent = 0;
  await assert.rejects(paidRequest(req, async () => { sent++; throw rejection; }), (error) => error === rejection);
  assert.equal(rejection.retryAfterSeconds, undefined, "no shared cooldown is injected for existing callers");
  const next = await paidRequest(req, async () => { sent++; return answer(); });
  assert.equal(next.reused, false);
  assert.equal(sent, 2, "an explicit later retry retains the old failed-receipt behavior");
  const attempts = await sql`SELECT status, attempt FROM receipt_attempts WHERE receipt_id = ${next.receiptId} ORDER BY attempt`;
  assert.deepEqual([...attempts], [{ status: "failed", attempt: 1 }, { status: "received", attempt: 2 }]);
});

test("invalid policies and reservation failures roll back quota and receipt admission together", async () => {
  const q = quota("invalid");
  for (const [index, invalid] of [
    { ...q, key: "" }, { ...q, intervalMs: -1 }, { ...q, intervalMs: Infinity }, { ...q, maxInflight: 0 },
    { ...q, maxInflight: 1.5 }, { ...q, leaseMs: 0 }, { ...q, leaseMs: Number.MAX_SAFE_INTEGER },
  ].entries()) {
    const req = request(`invalid-${index}`, invalid);
    await assert.rejects(paidRequest(req, () => { throw new Error("must not send"); }), /Provider quota/);
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipts WHERE subject = ${req.subject}`;
    assert.equal(row!.n, 0);
  }
  // JSON encoding fails after acquiring a lease but before the reservation transaction commits.
  const req = { ...request("reservation-failure", q), requestSummary: { invalidJson: 1n } };
  await assert.rejects(paidRequest(req, () => { throw new Error("must not send"); }), /BigInt/i);
  const [state] = await sql<{ quotas: number; receipts: number }[]>`SELECT
    (SELECT count(*)::int FROM provider_quotas WHERE quota_key = ${q.key}) AS quotas,
    (SELECT count(*)::int FROM receipts WHERE subject = ${req.subject}) AS receipts`;
  assert.deepEqual(state, { quotas: 0, receipts: 0 });
});

test("a response-save failure retains a pending receipt and its lease without another send", async () => {
  const q = quota("save-failure");
  const req = request("save-failure", q);
  let sent = 0;
  await assert.rejects(paidRequest(req, async () => { sent++; return { response: { invalidJson: 1n } }; }), /BigInt/i);
  const [row] = await sql`SELECT r.status, r.response, a.status AS attempt_status,
    (SELECT count(*)::int FROM provider_quota_leases WHERE quota_key = ${q.key}) AS leases
    FROM receipts r JOIN receipt_attempts a ON a.receipt_id = r.id WHERE r.subject = ${req.subject}`;
  assert.deepEqual(row, { status: "pending", response: null, attempt_status: "pending", leases: 1 });
  await assert.rejects(paidRequest(req, async () => { sent++; return answer(); }), ReceiptBusyError);
  await sql`UPDATE receipts SET updated_at = now() - interval '11 minutes' WHERE subject = ${req.subject}`;
  await assert.rejects(paidRequest(req, answer), ReceiptUnknownError);
  await sql`UPDATE provider_quota_leases SET expires_at = now() - interval '1 second' WHERE quota_key = ${q.key}`;
  assert.ok(await expireProviderQuotaLeases() >= 1);
  await assert.rejects(paidRequest(req, async () => { sent++; return answer(); }), ReceiptUnknownError);
  assert.equal(sent, 1, "lease cleanup never grants permission to resend an unknown logical request");
});

test("cooldowns never shrink and only a success after cooldown resets consecutive 429s", async () => {
  const q = { ...quota("cooldown-reset"), intervalMs: 0, maxInflight: 2 };
  const leases = await sql.begin(async (tx) => [await claimProviderQuota(tx, q), await claimProviderQuota(tx, q)]);
  await sql.begin(async (tx) => {
    assert.equal(await coolDownProviderQuota(tx, q, 120), 120);
    assert.ok(await coolDownProviderQuota(tx, q, 0) >= 119);
    await finishProviderQuota(tx, q, leases[0]!, true);
  });
  const [active] = await sql<{ rate_limit_failures: number }[]>`SELECT rate_limit_failures FROM provider_quotas WHERE quota_key = ${q.key}`;
  assert.equal(active!.rate_limit_failures, 2, "another inflight success cannot clear an active account cooldown");
  await sql`UPDATE provider_quotas SET cooldown_until = 'epoch' WHERE quota_key = ${q.key}`;
  await sql.begin((tx) => finishProviderQuota(tx, q, leases[1]!, true));
  const [reset] = await sql<{ rate_limit_failures: number }[]>`SELECT rate_limit_failures FROM provider_quotas WHERE quota_key = ${q.key}`;
  assert.equal(reset!.rate_limit_failures, 0);
});

/** Each child imports the same isolation setup and uses its own one-connection pool. */
async function independentProcess(body: string): Promise<string> {
  const code = `await import('./tests/setup.ts');
    const { paidRequest } = await import('@aihot/backend/providers/receipts');
    const { ProviderDeferredError } = await import('@aihot/backend/providers/provider-quotas');
    const { closeDb, sql } = await import('@aihot/backend/db');
    try { ${body} } finally { await closeDb(); }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, DATABASE_POOL_MAX: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errorOutput = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => { output += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { errorOutput = (errorOutput + part).slice(-2000); });
  const timeout = setTimeout(() => child.kill(), 10_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status) => status === 0 ? resolve() : reject(new Error(`quota child exited ${status}: ${errorOutput}`)));
    });
    return output;
  } finally { clearTimeout(timeout); }
}

test("completed requests enforce QPS across independent processes and distinct budget services", async () => {
  const q = { ...quota("process-qps"), intervalMs: 60_000, maxInflight: 2 };
  const first = request("process-qps-first", q);
  const second = { ...request("process-qps-second", q), service: `${service}-other` };
  assert.equal(await independentProcess(`await paidRequest(${JSON.stringify(first)}, async () => ({ response: { ok: true } })); process.stdout.write('finished');`), "finished");
  const [leases] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM provider_quota_leases WHERE quota_key = ${q.key}`;
  assert.equal(leases!.n, 0, "the second process is blocked by QPS, not a live concurrency lease");
  assert.equal(await independentProcess(`try {
    await paidRequest(${JSON.stringify(second)}, async () => { throw new Error('must not send'); });
    throw new Error('must defer');
  } catch (error) { if (!(error instanceof ProviderDeferredError)) throw error; process.stdout.write('deferred'); }`), "deferred");
  const [sent] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id WHERE r.subject IN (${first.subject}, ${second.subject})`;
  assert.equal(sent!.n, 1);
});

test("an inflight callback can query with a one-connection pool", async () => {
  const req = request("single-connection", { ...quota("single-connection"), intervalMs: 0 });
  assert.equal(await independentProcess(`await paidRequest(${JSON.stringify(req)}, async () => {
    const [row] = await sql\`SELECT 1 AS value\`;
    if (row.value !== 1) throw new Error('unexpected query result');
    return { response: { ok: true } };
  }); process.stdout.write('finished');`), "finished");
});

test("a process exit retains the committed lease and receipt until normal unknown recovery", async () => {
  const q = quota("process-exit");
  const req = request("process-exit", q);
  assert.equal(await independentProcess(`await paidRequest(${JSON.stringify(req)}, async () => {
    process.stdout.write('admitted'); process.exit(0);
  });`), "admitted");
  const [state] = await sql`SELECT r.status,
    (SELECT count(*)::int FROM provider_quota_leases WHERE quota_key = ${q.key}) AS leases
    FROM receipts r WHERE r.subject = ${req.subject}`;
  assert.deepEqual(state, { status: "pending", leases: 1 });
  await sql`UPDATE receipts SET updated_at = now() - interval '11 minutes' WHERE subject = ${req.subject}`;
  await assert.rejects(paidRequest(req, answer), ReceiptUnknownError);
  await sql`UPDATE provider_quota_leases SET expires_at = now() - interval '1 second' WHERE quota_key = ${q.key}`;
  await expireProviderQuotaLeases();
  await sql`UPDATE provider_quotas SET next_start_at = 'epoch' WHERE quota_key = ${q.key}`;
  await paidRequest(request("process-exit-new-request", q), answer);
  await assert.rejects(paidRequest(req, answer), ReceiptUnknownError);
});
