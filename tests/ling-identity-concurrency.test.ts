// Actual pg-boss worker, PostgreSQL and loopback provider; no external requests or fixture attemptTag.
import { gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { invalidateModelCache } from "@aihot/backend/editorial/models";
import { processArticle, queueProcessing, registerContentJobs } from "@aihot/backend/jobs/content";
import { getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const source = `ling-identity-worker-${T}`;
const workerQueue = `ling.identity.${T}`;
const originalAnalyzeQueue = QUEUES.analyze;
let heldReply: { text: string; arrived: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | undefined;
const provider = await stub(async (_hit, request) => {
  const held = heldReply;
  if (held && request.body.includes(held.text)) { held.arrived.open(); await held.release.promise; }
  return { choices: [{ finish_reason: "stop", message: {
    content: '{"label":"BLOCK","reason":"fictional local sample"}',
  } }] };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: `dummy-worker-${T}`,
  LLM_MODEL: "Ling-3.1-flash", PREFILTER_MODEL: "default", ANT_LING_QPS: "1000", ANT_LING_MAX_INFLIGHT: "2" });
for (const key of ["ANT_LING_BASE_URL", "ANT_LING_API_KEY", "ANT_LING_EXTRA_JSON", "LLM_EXTRA_JSON", "ANT_LING_QUOTA_GROUP"]) delete process.env[key];
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
  Object.assign(QUEUES, { analyze: originalAnalyzeQueue });
  await provider.close();
  try {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM pgboss.job WHERE data->>'articleId' IN (SELECT id FROM articles WHERE source_id=${source})`;
      await tx`DELETE FROM selected_ledger WHERE article_id IN (SELECT id FROM articles WHERE source_id=${source})`;
      await tx`DELETE FROM selected_state WHERE article_id IN (SELECT id FROM articles WHERE source_id=${source})`;
      await tx`DELETE FROM receipts WHERE subject IN (SELECT 'article:' || id || '@1' FROM articles WHERE source_id=${source})`;
      await tx`DELETE FROM articles WHERE source_id=${source}`;
      await tx`DELETE FROM sources WHERE id=${source}`;
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
  const id = `ling-worker-${T}-${name}`;
  const text = `Fictional company ${id} announced a contract with a disclosed amount. `.repeat(15);
  await sql`INSERT INTO articles (id,source_id,identity_key,url,title,discovered_at,timeline_at,body_text,body_status)
    VALUES (${id},${source},${id},${`https://example.invalid/${id}`},${`Fictional ${id}`},now(),now(),${text},'ok')`;
  return id;
}

test("two real articles process independently with default attemptTag while one request is pending", async () => {
  const first = await article("concurrent-a");
  const second = await article("concurrent-b");
  const held = { text: first, arrived: gate(), release: gate() };
  const hits = provider.hits();
  heldReply = held;
  const processing = processArticle(first);
  try {
    await held.arrived.promise;
    assert.deepEqual(await processArticle(second), { state: "block" });
    assert.equal(provider.hits(), hits + 2);
    const [b] = await sql`SELECT processing_state,processing_attempts FROM articles WHERE id=${second}`;
    assert.deepEqual(b, { processing_state: "blocked", processing_attempts: 0 });
  } finally {
    heldReply = undefined;
    held.release.open();
    assert.deepEqual(await processing, { state: "block" });
  }
  const rows = await sql`SELECT r.subject,r.status,r.attempts,a.status AS attempt_status FROM receipts r
    JOIN receipt_attempts a ON a.receipt_id=r.id
    WHERE r.subject IN (${`article:${first}@1`},${`article:${second}@1`}) ORDER BY r.subject`;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === "completed" && r.attempts === 1 && r.attempt_status === "received"));
});

test("real content worker preserves failure allowance for an unresolved historical identity", async () => {
  const first = await article("old-unknown");
  const second = await article("waiting");
  const hits = provider.hits();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { await originalFetch(url, init); throw new Error("loopback response lost after send"); };
  try { assert.deepEqual(await processArticle(first), { state: "unknown-receipt" }); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(provider.hits(), hits + 1);
  const [old] = await sql<{ id: number }[]>`SELECT id FROM receipts WHERE subject=${`article:${first}@1`}`;
  assert.ok(old);
  // A historical row with damaged identity cannot be authenticated or released automatically.
  await sql`UPDATE receipts SET logical_key=${`llm:prefilter_article:Ling-3.1-flash:${"a".repeat(64)}:0`},request='{}'::jsonb WHERE id=${old.id}`;
  await sql`UPDATE articles SET processing_attempts=2,processing_error='previous independent failure' WHERE id=${second}`;
  const boss = await getBoss();
  // Earlier files share this database and may leave eligible jobs in content.analyze. Keep
  // the production worker and enqueue path, but give this test its own real pg-boss queue.
  await boss.createQueue(workerQueue, { policy: "short", retryLimit: 4, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 });
  Object.assign(QUEUES, { analyze: workerQueue });
  await registerContentJobs(boss, 1);
  const jobId = await queueProcessing(second);
  assert.ok(jobId);
  const deadline = Date.now() + 20_000;
  let state: string | undefined;
  while ((state = (await boss.getJobById(workerQueue, jobId))?.state) !== "completed") {
    assert.ok(Date.now() < deadline, `content job did not complete its waiting transition (state: ${state ?? "missing"})`);
    await delay(50);
  }
  const [row] = await sql`SELECT processing_state,processing_attempts,processing_retry_at,processing_queued_at FROM articles WHERE id=${second}`;
  assert.equal(row!.processing_attempts, 2);
  assert.equal(row!.processing_state, "new");
  assert.ok(row!.processing_retry_at instanceof Date);
  assert.equal(row!.processing_queued_at, null);
  const [receipt] = await sql`SELECT r.status,r.attempts,a.status AS attempt_status FROM receipts r
    JOIN receipt_attempts a ON a.receipt_id=r.id WHERE r.id=${old.id}`;
  assert.deepEqual(receipt, { status: "unknown", attempts: 1, attempt_status: "unknown" });
  assert.equal((await sql`SELECT 1 FROM receipts WHERE subject=${`article:${second}@1`}`).length, 0);
  assert.equal(provider.hits(), hits + 1, "the ambiguous historical request is never automatically resent");
});
