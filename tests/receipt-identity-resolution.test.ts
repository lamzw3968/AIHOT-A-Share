// Real pg-boss, PostgreSQL and loopback Provider: no fixture attemptTag or external calls.
import { gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { invalidateModelCache } from "@aihot/backend/editorial/models";
import { processArticle, queueProcessing, registerContentJobs, sweepUnprocessed } from "@aihot/backend/jobs/content";
import { getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { releaseReceipt } from "@aihot/backend/operations/recover";
import { authorizeReceiptIdentityConflict, listReceiptIdentityConflicts, revokeReceiptIdentityConflict } from "@aihot/backend/operations/receipt-identity";
import { logicalKeyFor } from "@aihot/backend/providers/receipts";
import { lingQuota } from "@aihot/backend/providers/model-profile";

const target = new URL(process.env.DATABASE_URL!);
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(target.hostname)) throw new Error("requires loopback PostgreSQL");
const T = tag();
const source = `identity-resolution-${T}`;
const queue1 = `identity.resolution.one.${T}`;
const queue2 = `identity.resolution.two.${T}`;
const originalQueue = QUEUES.analyze;
let sentWire = "";
let heldReply: { text: string; arrived: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | undefined;
const provider = await stub(async (_n, request) => {
  sentWire = request.body;
  if (heldReply && request.body.includes(heldReply.text)) {
    heldReply.arrived.open();
    await heldReply.release.promise;
  }
  return { choices: [{ finish_reason: "stop", message: { content: '{"label":"BLOCK","reason":"fictional local fixture"}' } }] };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: `dummy-identity-${T}`,
  LLM_MODEL: "Ling-3.1-flash", PREFILTER_MODEL: "default", ANT_LING_QPS: "1000", ANT_LING_MAX_INFLIGHT: "2" });
for (const key of ["ANT_LING_BASE_URL", "ANT_LING_API_KEY", "ANT_LING_EXTRA_JSON", "LLM_EXTRA_JSON", "ANT_LING_QUOTA_GROUP"]) delete process.env[key];
const quota = lingQuota(`${provider.url}/v1`, process.env.LLM_API_KEY!, 85_000);
let savedSettings: Array<{ key: string; value: unknown; updated_by: string | null; updated_at: Date }> = [];
let savedBudget: Array<{ per_minute: number; per_hour: number; per_day: number }> = [];

before(async () => {
  savedSettings = await sql`SELECT key,value,updated_by,updated_at FROM settings WHERE key='models.prefilter'`;
  await sql`DELETE FROM settings WHERE key='models.prefilter'`;
  invalidateModelCache();
  savedBudget = await sql`SELECT per_minute,per_hour,per_day FROM budgets WHERE service='llm'`;
  await sql`INSERT INTO budgets (service,per_minute,per_hour,per_day) VALUES ('llm',100000,100000,1000000)
    ON CONFLICT (service) DO UPDATE SET per_minute=100000,per_hour=100000,per_day=1000000`;
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES (${source},'Loopback identity fixture','rss','T1','editorial','2100-01-01')`;
});

after(async () => {
  await stopBoss();
  Object.assign(QUEUES, { analyze: originalQueue });
  await provider.close();
  try {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM pgboss.job WHERE data->>'articleId' IN (SELECT id FROM articles WHERE source_id=${source})`;
      await tx`DELETE FROM selected_ledger WHERE article_id IN (SELECT id FROM articles WHERE source_id=${source})`;
      await tx`DELETE FROM selected_state WHERE article_id IN (SELECT id FROM articles WHERE source_id=${source})`;
      await tx`DELETE FROM receipts WHERE subject IN (SELECT 'article:' || id || '@1' FROM articles WHERE source_id=${source})`;
      await tx`DELETE FROM articles WHERE source_id=${source}`;
      await tx`DELETE FROM sources WHERE id=${source}`;
      await tx`DELETE FROM audit_log WHERE actor=${`identity-admin-${T}`}`;
      await tx`DELETE FROM provider_quota_leases WHERE quota_key=${quota.key}`;
      await tx`DELETE FROM provider_quotas WHERE quota_key=${quota.key}`;
      await tx`DELETE FROM settings WHERE key='models.prefilter'`;
      for (const r of savedSettings) await tx`INSERT INTO settings (key,value,updated_by,updated_at)
        VALUES (${r.key},${tx.json(r.value as never)},${r.updated_by},${r.updated_at})`;
      if (savedBudget.length) {
        const b = savedBudget[0]!;
        await tx`UPDATE budgets SET per_minute=${b.per_minute},per_hour=${b.per_hour},per_day=${b.per_day} WHERE service='llm'`;
      } else await tx`DELETE FROM budgets WHERE service='llm'`;
    });
  } finally { invalidateModelCache(); await closeDb(); }
});

async function article(name: string) {
  const id = `identity-${T}-${name}`;
  const text = `Fictional company ${id} announced a disclosed contract. `.repeat(15);
  await sql`INSERT INTO articles (id,source_id,identity_key,url,title,discovered_at,timeline_at,body_text,body_status,created_at)
    VALUES (${id},${source},${id},${`https://example.invalid/${id}`},${`Fictional ${id}`},now(),now(),${text},'ok',now())`;
  return id;
}

async function waitState(id: string, state: "new" | "blocked") {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const [row] = await sql`SELECT processing_state,processing_attempts,processing_retry_at,processing_queued_at,processing_error FROM articles WHERE id=${id}`;
    if (row?.processing_state === state && !row.processing_queued_at && (state !== "new" || row.processing_retry_at)) return row;
    await delay(100);
  }
  throw new Error(`worker did not reach ${state} for ${id}`);
}

const admin = `identity-admin-${T}`;
const expiry = () => new Date(Date.now() + 30 * 60_000).toISOString();

test("107 canonical identity needs separately audited per-request resolution and safely resumes via worker and sweep", async () => {
  const a = await article("old-a");
  const b = await article("new-b");
  const c = await article("new-c");
  const calls = provider.hits();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { await originalFetch(url, init); throw new Error("fictional loopback response lost"); };
  try { assert.deepEqual(await processArticle(a), { state: "unknown-receipt" }); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(provider.hits(), calls + 1);
  const [old] = await sql`SELECT id,logical_key,service,model,purpose,request,status,attempts FROM receipts WHERE subject=${`article:${a}@1`}`;
  assert.ok(old);
  const wireBody = sentWire;
  const body = JSON.parse(wireBody);
  const wireHash = sha256(wireBody);
  const canonicalHash = sha256(stableJson(body));
  assert.notEqual(wireHash, canonicalHash);
  assert.equal(old.request.bodyHash, wireHash);
  const v = old.request.identityV2;
  const oldIdentity = { model: v.model, promptVersion: v.promptVersion, system: v.system, user: v.user,
    temperature: v.temperature, maxTokens: v.maxTokens, extra: null, bodyHash: canonicalHash };
  const oldKey = logicalKeyFor({ service: old.service, purpose: old.purpose, model: old.model, identity: oldIdentity });
  assert.match(oldKey, /:0$/);
  await sql`UPDATE receipts SET logical_key=${oldKey},request=request-'identityV2' WHERE id=${old.id}`;
  await sql`UPDATE articles SET processing_attempts=2 WHERE id IN (${b},${c})`;
  await sql`UPDATE articles SET created_at=now()-interval '4 minutes' WHERE id=${b}`;

  const boss = await getBoss();
  await boss.createQueue(queue1, { policy: "short", retryLimit: 4, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 });
  Object.assign(QUEUES, { analyze: queue1 });
  await registerContentJobs(boss, 1);
  assert.ok(await queueProcessing(b));
  const firstWait = await waitState(b, "new");
  assert.equal(firstWait!.processing_attempts, 2);
  assert.match(firstWait!.processing_error, /ambiguous|identity|身份/i);
  const [conflict] = await sql`SELECT * FROM receipt_identity_conflicts WHERE receipt_id=${old.id} AND state='waiting'`;
  assert.ok(conflict);
  assert.match(conflict.request_key, /:0$/);
  const listed = await listReceiptIdentityConflicts();
  assert.ok(listed.conflicts.some((item) => String(item.id) === String(conflict.id)));

  // The existing release queues A. Stop that worker to model an A that must not be resent;
  // B will resume on its own production worker and queue below.
  await boss.offWork(queue1, { wait: true });
  const released = await releaseReceipt(old.id, { billed: true, note: "isolated fixture reconciliation" }, admin);
  assert.equal(released?.requeued, true);
  await boss.createQueue(queue2, { policy: "short", retryLimit: 4, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 });
  Object.assign(QUEUES, { analyze: queue2 });
  await registerContentJobs(boss, 1);
  await sql`UPDATE articles SET processing_retry_at=now()-interval '1 second' WHERE id=${b}`;
  assert.ok((await sweepUnprocessed()).enqueued >= 1);
  const stillWaiting = await waitState(b, "new");
  assert.equal(stillWaiting!.processing_attempts, 2);
  assert.match(stillWaiting!.processing_error, /ambiguous|identity|身份/i);
  assert.equal(provider.hits(), calls + 1);
  const good = { oldIdentity, wireBody, reason: "reviewed distinct fictional requests", expiresAt: expiry() };
  await assert.rejects(authorizeReceiptIdentityConflict(conflict.id, { ...good, wireBody: `${wireBody} ` }, admin));
  await assert.rejects(authorizeReceiptIdentityConflict(conflict.id, { ...good, oldIdentity: { ...oldIdentity, user: "0".repeat(64) } }, admin));
  await assert.rejects(authorizeReceiptIdentityConflict(conflict.id, { ...good, reason: "" }, admin));
  await assert.rejects(authorizeReceiptIdentityConflict(conflict.id, { ...good, expiresAt: new Date(Date.now() - 1000).toISOString() }, admin));
  // An administrator cannot turn equivalent bodies, including reordered object keys, into
  // distinct paid requests by inserting an arbitrary conflict snapshot.
  const reorderedBody = Object.fromEntries(Object.entries(body).reverse());
  assert.notEqual(JSON.stringify(reorderedBody), wireBody);
  assert.equal(sha256(stableJson(reorderedBody)), canonicalHash);
  const sameIdentity = { version: 2, model: v.model, promptVersion: v.promptVersion, system: v.system,
    user: v.user, temperature: v.temperature, maxTokens: v.maxTokens, extraHash: sha256(stableJson(null)),
    bodyHash: sha256(stableJson(reorderedBody)) };
  const sameKey = logicalKeyFor({ service: old.service, purpose: old.purpose, model: old.model, identity: sameIdentity });
  const [forged] = await sql`INSERT INTO receipt_identity_conflicts
    (receipt_id,receipt_key,receipt_wire_hash,receipt_attempts,request_key,request_identity,request_tag)
    VALUES (${old.id},${oldKey},${wireHash},${1},${sameKey},${sql.json(sameIdentity)},'0') RETURNING id`;
  await assert.rejects(authorizeReceiptIdentityConflict(forged!.id, good, admin), "equivalent canonical bodies cannot be authorized as different");
  const resolutions = await Promise.allSettled([
    authorizeReceiptIdentityConflict(conflict.id, good, admin),
    authorizeReceiptIdentityConflict(conflict.id, good, admin),
  ]);
  assert.equal(resolutions.filter((r) => r.status === "fulfilled").length, 1, "only one concurrent reviewer can authorize");
  assert.equal(resolutions.filter((r) => r.status === "rejected").length, 1);
  assert.equal(provider.hits(), calls + 1, "authorization does not send either request");
  const [authorized] = await sql`SELECT * FROM receipt_identity_conflicts WHERE id=${conflict.id}`;
  assert.equal(authorized!.state, "authorized");
  assert.equal(authorized!.actor, admin);
  assert.equal(authorized!.request_key, conflict.request_key);
  assert.equal(authorized!.receipt_id, old.id);
  assert.ok(authorized!.authorized_at instanceof Date);
  assert.equal(authorized!.reason, good.reason);
  await assert.rejects(authorizeReceiptIdentityConflict(conflict.id, good, admin));

  // Hold the attempt table after admission has reserved quota/receipt but before its
  // attempt INSERT can complete. Simulate expiry while that real transaction waits;
  // the post-write check must roll the entire reservation back before any HTTP send.
  const beforeQuota = await sql`SELECT next_start_at,cooldown_until,rate_limit_failures FROM provider_quotas WHERE quota_key=${quota.key}`;
  const beforeLeases = await sql`SELECT id,expires_at FROM provider_quota_leases WHERE quota_key=${quota.key} ORDER BY id`;
  const tableHeld = gate<number>();
  const releaseTable = gate();
  const tableBlocker = sql.begin(async (tx) => {
    const [pid] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await tx`LOCK TABLE receipt_attempts IN SHARE MODE`;
    tableHeld.open(pid!.pid);
    await releaseTable.promise;
  });
  const tablePid = await tableHeld.promise;
  try {
    await sql`UPDATE articles SET processing_retry_at=now()-interval '1 second' WHERE id=${b}`;
    assert.ok((await sweepUnprocessed()).enqueued >= 1);
    const deadline = Date.now() + 15_000;
    let attemptBlocked = false;
    while (Date.now() < deadline) {
      const waiting = await sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
        AND ${tablePid} = ANY(pg_blocking_pids(pid)) AND query ILIKE '%INSERT INTO receipt_attempts%'`;
      if (waiting.length) { attemptBlocked = true; break; }
      await delay(50);
    }
    assert.ok(attemptBlocked, "B must actually be blocked inserting its paid attempt");
    await sql`UPDATE receipt_identity_conflicts SET expires_at=now()-interval '1 second' WHERE id=${conflict.id}`;
  } finally { releaseTable.open(); await tableBlocker; }
  const expiryRaceWait = await waitState(b, "new");
  assert.equal(expiryRaceWait!.processing_attempts, 2);
  assert.match(expiryRaceWait!.processing_error, /expired|identity|身份/i);
  assert.equal(provider.hits(), calls + 1);
  assert.equal((await sql`SELECT 1 FROM receipts WHERE subject=${`article:${b}@1`}`).length, 0);
  assert.deepEqual(await sql`SELECT next_start_at,cooldown_until,rate_limit_failures FROM provider_quotas WHERE quota_key=${quota.key}`, beforeQuota);
  assert.deepEqual(await sql`SELECT id,expires_at FROM provider_quota_leases WHERE quota_key=${quota.key} ORDER BY id`, beforeLeases);
  assert.deepEqual(Array.from(await sql`SELECT status,attempt FROM receipt_attempts WHERE receipt_id=${old.id}`), [{ status: "unknown", attempt: 1 }]);
  await authorizeReceiptIdentityConflict(conflict.id, { ...good, expiresAt: expiry() }, admin);

  // The grant permits identity admission only; the existing budget fuse still controls sends.
  await sql`UPDATE budgets SET per_minute=0 WHERE service='llm'`;
  await sql`UPDATE articles SET processing_retry_at=now()-interval '1 second' WHERE id=${b}`;
  assert.ok((await sweepUnprocessed()).enqueued >= 1);
  const budgetWait = await waitState(b, "new");
  assert.equal(budgetWait!.processing_attempts, 2);
  assert.match(budgetWait!.processing_error, /budget/i);
  assert.equal(provider.hits(), calls + 1);
  await sql`UPDATE budgets SET per_minute=100000 WHERE service='llm'`;

  // This authorization is for B only: C remains unable to send while A's unknown is present.
  assert.ok(await queueProcessing(c));
  const otherWait = await waitState(c, "new");
  assert.equal(otherWait!.processing_attempts, 2);
  assert.match(otherWait!.processing_error, /ambiguous|identity|身份/i);
  assert.equal(provider.hits(), calls + 1);
  const [cConflict] = await sql`SELECT * FROM receipt_identity_conflicts WHERE receipt_id=${old.id} AND request_key<>${conflict.request_key} AND state='waiting'`;
  assert.ok(cConflict);

  // Force a real PostgreSQL interleaving: the revoker queues on the service's budget
  // advisory lock first, then the real worker queues on the same lock. Once released,
  // revocation must commit before the worker can make its admission decision.
  const locked = gate<number>();
  const unlock = gate();
  const blocker = sql.begin(async (tx) => {
    const [pid] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await tx`SELECT pg_advisory_xact_lock(hashtext('budget:llm'))`;
    locked.open(pid!.pid);
    await unlock.promise;
  });
  const pid = await locked.promise;
  async function waitForBlockers(count: number) {
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      const rows = await sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
        AND ${pid} = ANY(pg_blocking_pids(pid))`;
      if (rows.length >= count) return;
      await delay(50);
    }
    throw new Error(`expected ${count} PostgreSQL transactions blocked by test lock`);
  }
  const revoke = revokeReceiptIdentityConflict(conflict.id, { reason: "withdraw fictional review" }, admin);
  try {
    await waitForBlockers(1);
    await sql`UPDATE articles SET processing_retry_at=now()-interval '1 second' WHERE id=${b}`;
    assert.ok((await sweepUnprocessed()).enqueued >= 1);
    await waitForBlockers(2);
  } finally { unlock.open(); await blocker; }
  await revoke;
  await assert.rejects(revokeReceiptIdentityConflict(conflict.id, { reason: "duplicate revoke review" }, admin));
  const revokedWait = await waitState(b, "new");
  assert.equal(revokedWait!.processing_attempts, 2);
  assert.equal(provider.hits(), calls + 1);
  await authorizeReceiptIdentityConflict(conflict.id, { ...good, expiresAt: expiry() }, admin);

  // Expiry cannot turn into a permanent authorization. Reopen the same B work after expiring it.
  await sql`UPDATE receipt_identity_conflicts SET expires_at=now()-interval '1 second' WHERE id=${conflict.id}`;
  await sql`UPDATE articles SET processing_retry_at=now()-interval '1 second' WHERE id=${b}`;
  assert.ok((await sweepUnprocessed()).enqueued >= 1);
  const expiredWait = await waitState(b, "new");
  assert.equal(expiredWait!.processing_attempts, 2);
  assert.equal(provider.hits(), calls + 1);

  await authorizeReceiptIdentityConflict(conflict.id, { ...good, expiresAt: expiry() }, admin);
  await sql`UPDATE articles SET processing_retry_at=now()-interval '1 second' WHERE id=${b}`;
  // Once admission has committed and the HTTP request has actually arrived, revocation
  // must still be audited but cannot cancel or erase the already-sent request.
  const held = { text: b, arrived: gate(), release: gate() };
  heldReply = held;
  try {
    assert.ok((await sweepUnprocessed()).enqueued >= 1);
    await Promise.race([held.arrived.promise, delay(30_000, undefined, { ref: false }).then(() => { throw new Error("provider never received admitted B"); })]);
    assert.equal(provider.hits(), calls + 2);
    await revokeReceiptIdentityConflict(conflict.id, { reason: "withdraw after send began" }, admin);
  } finally { heldReply = undefined; held.release.open(); }
  const completed = await waitState(b, "blocked");
  assert.equal(completed!.processing_attempts, 0);
  assert.equal(provider.hits(), calls + 2, "B sends once, A is never automatically resent by identity resolution");
  const rows = await sql`SELECT r.subject,r.logical_key,r.status,r.attempts,a.status AS attempt_status FROM receipts r
    JOIN receipt_attempts a ON a.receipt_id=r.id WHERE r.subject IN (${`article:${a}@1`},${`article:${b}@1`},${`article:${c}@1`}) ORDER BY r.subject`;
  assert.equal(rows.length, 2);
  const aRow = rows.find((row) => row.subject === `article:${a}@1`);
  const bRow = rows.find((row) => row.subject === `article:${b}@1`);
  assert.equal(aRow!.logical_key, oldKey);
  assert.equal(aRow!.status, "failed");
  assert.equal(aRow!.attempts, 1);
  assert.equal(aRow!.attempt_status, "unknown");
  assert.equal(bRow!.status, "completed");
  assert.equal(bRow!.attempts, 1);
  assert.equal(bRow!.attempt_status, "received");
  const audits = await sql`SELECT actor,action,subject,reason,created_at FROM audit_log WHERE actor=${admin} ORDER BY id`;
  assert.ok(audits.some((entry) => entry.action === "receipt.release"));
  assert.ok(audits.some((entry) => String(entry.action).includes("identity") && entry.reason === good.reason));
  assert.ok(audits.some((entry) => String(entry.action).includes("identity") && entry.reason === "withdraw fictional review"));
  assert.ok(audits.some((entry) => String(entry.action).includes("identity") && entry.reason === "withdraw after send began"));
  const leases = await sql`SELECT id FROM provider_quota_leases WHERE quota_key=${quota.key}`;
  assert.equal(leases.length, 1, "only the potentially charged unknown A retains its lease");
});
