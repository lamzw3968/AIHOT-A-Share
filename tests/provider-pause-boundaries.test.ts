// Exercise the real callers before any paid request and against actual loopback HTTP 429s.
// Phase two does not connect chatJson to quotas: a getter injects a typed unsent wait before
// paidRequest. Phase-one quota tests separately cover real admission/receipt atomicity.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test, type TestContext } from "node:test";
import type { JobWithMetadata } from "pg-boss";
import { closeDb, sql } from "@aihot/backend/db";
import { queueProcessing, registerContentJobs, sweepUnprocessed } from "@aihot/backend/jobs/content";
import { getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { invalidateModelCache } from "@aihot/backend/editorial/models";
import { translatePending, translateQuotes } from "@aihot/backend/editorial/translate";
import { catchUpReports } from "@aihot/backend/reports/compose";
import { MODELS } from "@aihot/backend/providers/llm";
import { ProviderDeferredError } from "@aihot/backend/providers/provider-quotas";
import { ProviderRejectedError } from "@aihot/backend/providers/receipts";

const T = tag();
const SOURCE = `pause-boundary-${T}`;
const X_SOURCE = `pause-quote-${T}`;
const KEY = `dummy-boundary-${T}`;
let reject429 = false;
const provider = await stub(() => reject429 ? new Reply(429, { error: "isolated provider is busy" })
  : { choices: [{ finish_reason: "stop", message: { content: '{"label":"BLOCK","reason":"Fictional local recovery sample"}' } }] });
const endpoint = `${provider.url}/v1`;
const reportDate = "1901-02-02";
const seedReportDate = "1901-02-01";
const ownArticles: string[] = [];
const ownQuotes: string[] = [];
let savedSettings: Array<{ key: string; value: unknown; updated_by: string | null; updated_at: Date }> = [];
let savedBudget: Array<{ service: string; per_minute: number; per_hour: number; per_day: number }> = [];

Object.assign(process.env, {
  LLM_BASE_URL: endpoint, LLM_API_KEY: KEY, LLM_MODEL: "isolated-boundary-model", LLM_JSON_MODE: "true", LLM_VISION: "false",
  PREFILTER_MODEL: "default", REPORT_MODEL: "default", TRANSLATE_MODEL: "default",
});
for (const name of ["LLM_EXTRA_JSON", "ANT_LING_EXTRA_JSON", "ANT_LING_QUOTA_GROUP", "ANT_LING_QPS", "ANT_LING_MAX_INFLIGHT"]) delete process.env[name];

before(async () => {
  savedSettings = await sql`SELECT key, value, updated_by, updated_at FROM settings WHERE key IN ('models.prefilter', 'models.report', 'models.translate')`;
  await sql`DELETE FROM settings WHERE key IN ('models.prefilter', 'models.report', 'models.translate')`;
  invalidateModelCache();
  // Keep shared test counts intact; lift and then restore only this file's budget limits.
  savedBudget = await sql`SELECT service, per_minute, per_hour, per_day FROM budgets WHERE service = 'llm'`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('llm', 100000, 100000, 1000000)
    ON CONFLICT (service) DO UPDATE SET per_minute = 100000, per_hour = 100000, per_day = 1000000`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, next_fetch_at)
    VALUES (${SOURCE}, 'Fake finance boundary source', 'rss', 'T1', 'editorial', true, '2100-01-01'),
           (${X_SOURCE}, 'Fake quote boundary source', 'x_search', 'T1', 'editorial', true, '2100-01-01')`;
  assert.equal(provider.hits(), 0);
});

after(async () => {
  await stopBoss();
  await provider.close();
  await sql`DELETE FROM settings WHERE key IN ('models.prefilter', 'models.report', 'models.translate')`;
  for (const r of savedSettings) await sql`INSERT INTO settings (key, value, updated_by, updated_at)
    VALUES (${r.key}, ${sql.json(r.value as never)}, ${r.updated_by}, ${r.updated_at})`;
  invalidateModelCache();
  if (savedBudget.length) {
    const b = savedBudget[0]!;
    await sql`UPDATE budgets SET per_minute = ${b.per_minute}, per_hour = ${b.per_hour}, per_day = ${b.per_day} WHERE service = 'llm'`;
  } else await sql`DELETE FROM budgets WHERE service = 'llm'`;
  await sql`DELETE FROM reports WHERE kind = 'daily' AND key IN (${seedReportDate}, ${reportDate})`;
  if (ownArticles.length) await sql`DELETE FROM articles WHERE id IN ${sql(ownArticles)}`;
  await sql`DELETE FROM sources WHERE id IN (${SOURCE}, ${X_SOURCE})`;
  await closeDb();
});

async function article(suffix: string, opts: { at?: Date; channel?: "news" | "x"; full?: boolean; quoteId?: string } = {}) {
  const id = `pause-${T}-${suffix}`;
  const at = opts.at ?? new Date();
  const text = `Fictional company ${T}-${suffix} announced a new contract with disclosed amounts and implementation dates. `.repeat(8);
  const xPost = opts.quoteId ? { text: "引用内容", quoted: { text: `Fictional overseas company ${T} announced a new manufacturing contract.`, url: `https://x.com/fake/status/${opts.quoteId}` } } : null;
  if (opts.quoteId) ownQuotes.push(opts.quoteId);
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, language, discovered_at, timeline_at, body_text, body_html, body_status, x_post)
    VALUES (${id}, ${opts.channel === "x" ? X_SOURCE : SOURCE}, ${id}, ${`https://example.invalid/${id}`}, ${`Fictional contract ${id}`},
      ${opts.channel === "x" ? "zh" : "en"}, ${at}, ${at}, ${text}, ${`<p>${text}</p>`}, 'ok', ${xPost ? sql.json(xPost) : null})`;
  ownArticles.push(id);
  if (opts.channel) await sql`INSERT INTO publications
    (article_id, source_id, title, summary, channel, url, discovered_at, timeline_at, sort_at, eligible, selected, visible_after, visibility, score, category, body_mode)
    VALUES (${id}, ${opts.channel === "x" ? X_SOURCE : SOURCE}, ${`Fictional contract ${id}`}, '虚构订单测试摘要', ${opts.channel},
      ${`https://example.invalid/${id}`}, ${at}, ${at}, ${at}, true, true, ${at}, 'public', 90, 'company', ${opts.full ? "full" : "summary"})`;
  return id;
}

function injectUnsentWait(t: TestContext) {
  const pause = new ProviderDeferredError(new Date(Date.now() + 3_600_000));
  return t.mock.getter(MODELS.default!, "extra", () => { throw pause; });
}

async function assertUnsent(subject: string, hits = 0) {
  const [counts] = await sql<{ receipts: number; attempts: number }[]>`
    SELECT (SELECT count(*)::int FROM receipts WHERE subject = ${subject}) AS receipts,
      (SELECT count(*)::int FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id WHERE r.subject = ${subject}) AS attempts`;
  assert.deepEqual(counts, { receipts: 0, attempts: 0 });
  assert.equal(provider.hits(), hits, "an unsent wait never sends another HTTP request");
}

test("the real content handler waits for quota without increasing processing_attempts", async (t) => {
  injectUnsentWait(t);
  const id = await article("content");
  await sql`UPDATE articles SET processing_attempts = 2, processing_error = 'prior failure', processing_queued_at = now() WHERE id = ${id}`;
  const boss = await getBoss();
  type Data = { articleId: string; attemptTag?: string };
  const captured: { callback?: (jobs: JobWithMetadata<Data>[]) => Promise<unknown> } = {};
  const registered = t.mock.method(boss, "work", async (_name: string, _options: unknown, handler: (jobs: JobWithMetadata<Data>[]) => Promise<unknown>) => {
    captured.callback = handler;
    return `captured-${T}`;
  });
  await registerContentJobs(boss, 1);
  registered.mock.restore();
  assert.ok(captured.callback, "capture the real content handler without starting a shared queue poller");
  const queue = `pause.boundary.${T}`;
  await boss.createQueue(queue, { retryLimit: 3, expireInSeconds: 60 });
  const jobId = await boss.send(queue, { articleId: id, attemptTag: `pause-${T}` });
  assert.ok(jobId);
  const [job] = await boss.fetch<Data>(queue, { includeMetadata: true });
  assert.ok(job);
  const result = await captured.callback([job]);
  assert.equal((result as { state: string }).state, "waiting");
  const [current] = await sql<{ processing_state: string; processing_attempts: number; processing_retry_at: Date; processing_queued_at: Date | null }[]>`
    SELECT processing_state, processing_attempts, processing_retry_at, processing_queued_at FROM articles WHERE id = ${id}`;
  assert.equal(current!.processing_state, "new");
  assert.equal(current!.processing_attempts, 2, "an unsent admission wait preserves the previous failure count");
  assert.equal(current!.processing_queued_at, null);
  assert.ok(current!.processing_retry_at.getTime() > Date.now() + 3_500_000);
  await assertUnsent(`article:${id}@1`);
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id = ${id}`).length, 0);
  await boss.complete(queue, job.id);
});

test("catch-up reports propagate quota waiting instead of aggregating it into a report failure", async (t) => {
  injectUnsentWait(t);
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at)
    VALUES ('daily', ${seedReportDate}, '1901-01-31T00:00:00Z', '1901-02-01T00:00:00Z', '{}', now())`;
  await article("report", { at: new Date("1901-02-01T12:00:00Z"), channel: "news" });
  await assert.rejects(catchUpReports(new Date("1901-02-02T03:00:00Z")), (error) => {
    assert.ok(error instanceof ProviderDeferredError, "the original typed wait must reach the cron continuation wrapper");
    assert.ok(error.retryAfterSeconds > 3500);
    return true;
  });
  assert.equal((await sql`SELECT 1 FROM reports WHERE kind = 'daily' AND key = ${reportDate}`).length, 0);
  await assertUnsent(`report:daily:${reportDate}`);
});

test("pending full-text translation propagates quota waiting without recording a failed translation attempt", async (t) => {
  injectUnsentWait(t);
  const id = await article("translation", { at: new Date("2200-01-01T00:00:00Z"), channel: "news", full: true });
  await assert.rejects(translatePending({ limit: 1 }), ProviderDeferredError);
  assert.equal((await sql`SELECT 1 FROM translation_attempts WHERE article_id = ${id}`).length, 0);
  assert.equal((await sql`SELECT 1 FROM translations WHERE article_id = ${id}`).length, 0);
  await assertUnsent(`article:${id}@1#0`);
});

test("quoted-post translation and its pending-run catch both preserve quota waiting", async (t) => {
  injectUnsentWait(t);
  const quoteId = `1${Date.now()}`;
  await article("quote", { at: new Date("2200-01-02T00:00:00Z"), channel: "x", full: true, quoteId });
  // A future cutoff isolates this quote from the other invariant tests' recent X fixtures.
  await assert.rejects(translateQuotes({ days: -365 }), ProviderDeferredError);
  await assert.rejects(translatePending({ limit: 0 }), ProviderDeferredError);
  assert.equal((await sql`SELECT 1 FROM quote_translations WHERE tweet_id = ${quoteId}`).length, 0);
  await assertUnsent(`quote:${quoteId}`);
});

test("real HTTP 429s remain paid failures and propagate through report and translation batch boundaries", async () => {
  const beforeHits = provider.hits();
  reject429 = true;
  const rateLimit = (error: unknown) => error instanceof ProviderRejectedError && error.status === 429 && error.retryable;
  try {
    await assert.rejects(catchUpReports(new Date("1901-02-02T03:00:00Z")), rateLimit);
    await assert.rejects(translatePending({ limit: 1 }), rateLimit);
    await assert.rejects(translateQuotes({ days: -365 }), rateLimit);
    await assert.rejects(translatePending({ limit: 0 }), rateLimit);
    assert.equal(provider.hits() - beforeHits, 4, "each actual 429 was one HTTP request");
    const subjects = [`report:daily:${reportDate}`, `article:pause-${T}-translation@1#0`, ...ownQuotes.map((id) => `quote:${id}`)];
    const rows = await sql<{ status: string; attempt: number }[]>`
      SELECT a.status, a.attempt FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id WHERE r.subject IN ${sql(subjects)}`;
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r.status === "failed"));
    assert.equal((await sql`SELECT 1 FROM translation_attempts WHERE article_id = ${`pause-${T}-translation`}`).length, 0,
      "pause is not misrecorded as a failed translation output");
    assert.equal((await sql`SELECT 1 FROM reports WHERE kind = 'daily' AND key = ${reportDate}`).length, 0);
  } finally { reject429 = false; }
});

test("content waiting is recovered by the existing sweep and finishes through a real pg-boss worker", async (t) => {
  const boss = await getBoss();
  // Other tests' fixtures share this throwaway database. Park and restore them while a real
  // content poller is active; the poller is stopped before restoring their eligibility.
  const parkedJobs = await sql<{ id: string; start_after: Date }[]>`
    SELECT id, start_after FROM pgboss.job WHERE name = ${QUEUES.analyze} AND state IN ('created', 'retry')`;
  const parkedArticles = await sql<{ id: string; processing_queued_at: Date | null }[]>`
    SELECT id, processing_queued_at FROM articles WHERE processing_state = 'new'`;
  if (parkedJobs.length) await sql`UPDATE pgboss.job SET start_after = '2100-01-01' WHERE id = ANY(${parkedJobs.map((r) => r.id)}::uuid[])`;
  if (parkedArticles.length) await sql`UPDATE articles SET processing_queued_at = '2100-01-01' WHERE id = ANY(${parkedArticles.map((r) => r.id)}::text[])`;
  let worker: string | undefined;
  try {
    const id = await article("sweep-recovery");
    const attemptTag = `pause-sweep-${T}`;
    await sql`UPDATE articles SET created_at = now() - interval '4 minutes', processing_attempts = 2 WHERE id = ${id}`;
    const hits = provider.hits();
    const pause = injectUnsentWait(t);
    type Data = { articleId: string; attemptTag?: string };
    const captured: { callback?: (jobs: JobWithMetadata<Data>[]) => Promise<unknown> } = {};
    const registration = t.mock.method(boss, "work", async (_name: string, _options: unknown, handler: (jobs: JobWithMetadata<Data>[]) => Promise<unknown>) => {
      captured.callback = handler;
      return `capture-sweep-${T}`;
    });
    await registerContentJobs(boss, 1);
    registration.mock.restore();
    await queueProcessing(id, { attemptTag });
    const [job] = await boss.fetch<Data>(QUEUES.analyze, { includeMetadata: true });
    assert.ok(job);
    assert.equal(job.data.articleId, id);
    assert.equal((await captured.callback!([job]) as { state: string }).state, "waiting");
    await boss.complete(QUEUES.analyze, job.id);
    await assertUnsent(`article:${id}@1`, hits);
    const [waiting] = await sql`SELECT processing_attempts, processing_attempt_tag, processing_retry_at FROM articles WHERE id = ${id}`;
    assert.equal(waiting!.processing_attempts, 2);
    assert.equal(waiting!.processing_attempt_tag, attemptTag);
    assert.ok(waiting!.processing_retry_at > new Date());
    assert.equal((await sql`SELECT 1 FROM provider_deferred_jobs WHERE current_job_id = ${job.id}`).length, 0,
      "content uses processing_retry_at rather than a second durable recovery path");
    pause.mock.restore();
    await sql`UPDATE articles SET processing_retry_at = now() - interval '1 second' WHERE id = ${id}`;
    assert.ok((await sweepUnprocessed()).enqueued >= 1);
    const originalWork = boss.work.bind(boss);
    const captureWorker = t.mock.method(boss, "work", async (...args: Parameters<typeof boss.work>) => {
      worker = await originalWork(...args);
      return worker;
    });
    await registerContentJobs(boss, 1);
    captureWorker.mock.restore();
    const deadline = Date.now() + 12_000;
    while (true) {
      const [current] = await sql`SELECT processing_state, processing_queued_at FROM articles WHERE id = ${id}`;
      if (current!.processing_state === "blocked" && current!.processing_queued_at === null) break;
      assert.ok(Date.now() < deadline, "content sweep did not complete");
      await delay(20);
    }
    assert.equal(provider.hits(), hits + 1);
    const [analysis] = await sql`SELECT relevance, selected FROM analyses WHERE article_id = ${id}`;
    assert.equal(analysis!.relevance, "block");
    assert.equal(analysis!.selected, false);
    const receipts = await sql`SELECT logical_key FROM receipts WHERE subject = ${`article:${id}@1`}`;
    assert.equal(receipts.length, 1);
    assert.ok(String(receipts[0]!.logical_key).endsWith(`:${attemptTag}`), "sweep preserves the paid request's attemptTag");
  } finally {
    if (worker) await boss.offWork(QUEUES.analyze, { id: worker, wait: true });
    if (parkedJobs.length) await sql`UPDATE pgboss.job j SET start_after = old.start_after
      FROM jsonb_to_recordset(${sql.json(parkedJobs as never)}) AS old(id uuid, start_after timestamptz) WHERE j.id = old.id`;
    if (parkedArticles.length) await sql`UPDATE articles a SET processing_queued_at = old.processing_queued_at
      FROM jsonb_to_recordset(${sql.json(parkedArticles as never)}) AS old(id text, processing_queued_at timestamptz) WHERE a.id = old.id`;
  }
});

test("the content handler counts an actual 429 as a business failure", async (t) => {
  const id = await article("sent-429");
  const boss = await getBoss();
  type Data = { articleId: string; attemptTag?: string };
  const captured: { callback?: (jobs: JobWithMetadata<Data>[]) => Promise<unknown> } = {};
  const registration = t.mock.method(boss, "work", async (_name: string, _options: unknown, callback: (jobs: JobWithMetadata<Data>[]) => Promise<unknown>) => {
    captured.callback = callback;
    return `capture-sent-${T}`;
  });
  await registerContentJobs(boss, 1);
  registration.mock.restore();
  const queue = `pause.sent.${T}`;
  await boss.createQueue(queue, { retryLimit: 1, expireInSeconds: 60 });
  const jobId = await boss.send(queue, { articleId: id });
  assert.ok(jobId);
  const [job] = await boss.fetch<Data>(queue, { includeMetadata: true });
  assert.ok(job);
  const hits = provider.hits();
  reject429 = true;
  try {
    assert.equal((await captured.callback!([job]) as { state: string }).state, "retrying");
    const [current] = await sql`SELECT processing_attempts, processing_retry_at FROM articles WHERE id = ${id}`;
    assert.equal(current!.processing_attempts, 1);
    assert.ok(current!.processing_retry_at > new Date());
    const attempts = await sql`SELECT a.status FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id WHERE r.subject = ${`article:${id}@1`}`;
    assert.deepEqual(attempts.map((r) => r.status), ["failed"]);
    assert.equal(provider.hits(), hits + 1);
  } finally { reject429 = false; await boss.complete(queue, job.id); }
});
