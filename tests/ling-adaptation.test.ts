// Real receipts, quotas and pg-boss, with fake credentials and loopback HTTP only.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { z } from "zod";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { chatJson, MODELS, ModelOutputError } from "@aihot/backend/providers/llm";
import { assertLingConfiguration, isLingModel, lingChatEndpoint, lingDefaultMatches, lingProfile, lingQuota } from "@aihot/backend/providers/model-profile";
import { BudgetExceededError, logicalKeyFor, ProviderRejectedError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { ProviderDeferredError } from "@aihot/backend/providers/provider-quotas";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { resumeDeferredProviderJobs, runProviderAwareJob } from "@aihot/backend/jobs/provider-deferred";
import { runSelectionScores, type AnalyzeInputArticle } from "@aihot/backend/editorial/analyze";
import { sha256 } from "@aihot/backend/lib/ids";

const T = tag();
const schema = z.object({ ok: z.boolean() });
const system = "Return test JSON";
const seen: Array<{ body: Record<string, unknown>; url: string; at: number }> = [];
let reply: { status?: number; headers?: Record<string, string>; raw?: string; content?: unknown; missing?: boolean; finish?: string; score?: boolean; noId?: boolean } = {};
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    seen.push({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")), url: req.url!, at: Date.now() });
    assert.match(String(req.headers.authorization), /^Bearer dummy-ling-/);
    res.writeHead(reply.status ?? 200, { "content-type": "application/json", "x-request-id": `header-${T}`, ...reply.headers });
    res.end(reply.raw ?? JSON.stringify({ ...(reply.noId ? {} : { id: `ling-${T}-${seen.length}` }),
      choices: [{ finish_reason: reply.finish ?? "stop", message: {
        ...(reply.missing ? {} : { content: "content" in reply ? reply.content : reply.score ? '{"attentionScore":80}' : '{"ok":true}' }),
        reasoning_content: "private mock reasoning",
      } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
let generation = 0;

function configure(extra?: unknown) {
  generation++;
  for (const name of Object.keys(process.env)) if (name.startsWith("ANT_LING_") || ["LLM_EXTRA_JSON", "LLM_JSON_MODE"].includes(name)) delete process.env[name];
  Object.assign(process.env, { LLM_BASE_URL: endpoint, LLM_API_KEY: `dummy-ling-${T}-${generation}`, LLM_MODEL: "Ling-3.1-flash",
    ANT_LING_BASE_URL: endpoint, ANT_LING_API_KEY: `dummy-ling-${T}-${generation}` });
  if (extra !== undefined) process.env.LLM_EXTRA_JSON = JSON.stringify(extra);
  reply = {};
}

function ask(subject: string, opts: { model?: string; maxTokens?: number; timeoutMs?: number; json?: boolean; parse?: (text: string) => unknown; purpose?: string } = {}) {
  return chatJson({ model: opts.model ?? "default", purpose: opts.purpose ?? "ling_adaptation_test", subject,
    promptVersion: "ling-v1", system, user: `input ${subject}`, schema, maxTokens: opts.maxTokens ?? 512, ...opts });
}

async function counts(subject: string) {
  const [row] = await sql`SELECT (SELECT count(*)::int FROM receipts WHERE subject = ${subject}) AS receipts,
    (SELECT count(*)::int FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id WHERE r.subject = ${subject}) AS attempts`;
  return row!;
}

async function failed(id: number) {
  const [row] = await sql`SELECT r.status, r.response,
    (SELECT count(*)::int FROM receipt_attempts a WHERE a.receipt_id = r.id) AS attempts,
    (SELECT count(*)::int FROM receipt_attempts a WHERE a.receipt_id = r.id AND a.status = 'received') AS received
    FROM receipts r WHERE id = ${id}`;
  assert.equal(row!.status, "failed");
  assert.equal(row!.attempts, 1);
  assert.equal(row!.received, 1, "HTTP succeeded; only the logical output is failed");
  assert.ok(row!.response, "the original answer is retained before validation");
  return row!;
}

after(async () => { await stopBoss(); await new Promise<void>((resolve) => server.close(() => resolve())); await closeDb(); });

test("Ling preset uses the existing llm budget and resolves independent configuration at call time", async () => {
  configure({ max_tokens: 7000 });
  assert.equal(MODELS["ling-3.1-flash"]!.model, "Ling-3.1-flash");
  assert.equal(MODELS["ling-3.1-flash"]!.service, "llm");
  assert.equal(MODELS["ling-3.1-flash"]!.vision, false);
  process.env.ANT_LING_EXTRA_JSON = '{"max_tokens":777,"temperature":0.6}';
  await ask(`dedicated-${T}`, { model: "ling-3.1-flash" });
  assert.equal(seen.at(-1)!.body.max_tokens, 777);
  assert.equal(seen.at(-1)!.body.temperature, 0.6);
  assert.equal(seen.at(-1)!.body.model, "Ling-3.1-flash");
  assert.deepEqual(seen.at(-1)!.body.response_format, { type: "json_object" });
});

test("only the target Ling model is recognized, without applying its profile to other Ling or Ring models", () => {
  configure();
  for (const model of ["Ling-3.1-flash", "ling-3.1-flash", "LING-3.1-FLASH"]) assert.equal(isLingModel(model), true);
  for (const model of ["Ling-3.0-flash", "Ling-future", "Ring-2.6-1T", "glm-5.3-flash", "Ling-3.1-flashx"]) assert.equal(isLingModel(model), false);
  assert.throws(() => assertLingConfiguration("Ling-future", "https://api.ant-ling.com/v1"), /unsupported|not supported/i);
  assert.throws(() => assertLingConfiguration("Ring-2.6-1T", "https://api.ant-ling.com/v1"), /unsupported|not supported/i);
  assert.doesNotThrow(() => assertLingConfiguration("custom-model", endpoint));
});

test("safe fallback validates the full official authority, route and actual model", () => {
  for (const path of ["/v1", "/v1/", "/v1///", "/v1/chat/completions", "/v1/chat/completions///"]) {
    assert.equal(lingDefaultMatches(`https://api.ant-ling.com${path}`, "lING-3.1-FLASH"), true);
  }
  for (const url of ["http://api.ant-ling.com/v1", "https://api.ant-ling.com.evil.example/v1", "https://user:secret@api.ant-ling.com/v1",
    "https://api.ant-ling.com:444/v1", "https://api.ant-ling.com/v1?key=dummy", "https://api.ant-ling.com/v1#fragment", endpoint,
    "https://open.bigmodel.cn/api/paas/v4", "https://api.ant-ling.com/v2"]) assert.equal(lingDefaultMatches(url, "Ling-3.1-flash"), false);
  assert.equal(lingDefaultMatches("https://api.ant-ling.com/v1", "Ling-future"), false);
});

test("Ling endpoints normalize trailing slashes and never append the completion route twice", async () => {
  for (const path of ["/", "///", "/chat/completions", "/chat/completions///"]) {
    configure();
    process.env.LLM_BASE_URL = endpoint + path;
    assert.equal(lingChatEndpoint(process.env.LLM_BASE_URL), endpoint + "/chat/completions");
    await ask(`path-${generation}-${T}`);
    assert.equal(seen.at(-1)!.url, "/v1/chat/completions");
  }
});

test("incomplete dedicated config and unsafe default fallback fail before any paid reservation", async () => {
  for (const missing of ["ANT_LING_BASE_URL", "ANT_LING_API_KEY", "both"]) {
    configure();
    delete process.env[missing];
    if (missing === "both") { delete process.env.ANT_LING_BASE_URL; delete process.env.ANT_LING_API_KEY; }
    const subject = `partial-${missing}-${T}`;
    const hits = seen.length;
    await assert.rejects(ask(subject, { model: "ling-3.1-flash" }), /not configured|incomplete/i);
    assert.equal(seen.length, hits);
    assert.deepEqual(await counts(subject), { receipts: 0, attempts: 0 });
  }
  configure();
  process.env.LLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
  const subject = `wrong-official-${T}`;
  await assert.rejects(ask(subject), /match|endpoint/i);
  assert.deepEqual(await counts(subject), { receipts: 0, attempts: 0 });
});

test("official fallback and mixed-case default share canonical request identity and cached answer", async () => {
  configure({ max_tokens: 5000 });
  delete process.env.ANT_LING_BASE_URL; delete process.env.ANT_LING_API_KEY;
  process.env.LLM_BASE_URL = "https://api.ant-ling.com/v1///";
  process.env.LLM_MODEL = "lING-3.1-FLASH";
  const fetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    assert.equal(String(url), "https://api.ant-ling.com/v1/chat/completions");
    return fetch(endpoint + "/chat/completions", init);
  };
  try {
    const subject = `fallback-${T}`;
    const first = await ask(subject);
    const hits = seen.length;
    const alias = await ask(subject, { model: "ling-3.1-flash" });
    assert.equal(alias.receiptId, first.receiptId);
    assert.equal(alias.reused, true);
    assert.equal(seen.length, hits);
    assert.equal(seen.at(-1)!.body.model, "Ling-3.1-flash");
    assert.equal(seen.at(-1)!.body.max_tokens, 5000);
  } finally { globalThis.fetch = fetch; }
});

test("Ling short purposes receive 4096 tokens without guessed thinking controls", async () => {
  configure();
  for (const [purpose, maxTokens] of [["prefilter_article", 512], ["score_article", 1024], ["group_review", 400], ["story_digest", 1200], ["report_lead", 800]] as const) {
    await ask(`purpose-${purpose}-${T}`, { purpose, maxTokens });
    const body = seen.at(-1)!.body;
    assert.equal(body.max_tokens, 4096);
    assert.deepEqual(body.response_format, { type: "json_object" });
    for (const field of ["thinking", "reasoning", "reasoning_effort", "enable_thinking"]) assert.equal(field in body, false);
  }
});

test("larger task budgets and explicit operator tokens win; Ling HTTP timeout is capped at 85 seconds", () => {
  configure();
  assert.equal(lingProfile(MODELS.default!, { maxTokens: 16_384 }).maxTokens, 16_384);
  assert.equal(lingProfile(MODELS.default!, {}).timeoutMs, 85_000);
  assert.equal(lingProfile(MODELS.default!, { timeoutMs: 180_000 }).timeoutMs, 85_000);
  assert.equal(lingProfile(MODELS.default!, { timeoutMs: 5000 }).timeoutMs, 5000);
  process.env.ANT_LING_MIN_OUTPUT_TOKENS = "8192";
  assert.equal(lingProfile(MODELS.default!, {}).maxTokens, 8192);
  process.env.LLM_EXTRA_JSON = '{"max_tokens":777,"temperature":0}';
  assert.equal(lingProfile(MODELS.default!, {}).maxTokens, 777);
  assert.equal(lingProfile(MODELS.default!, {}).temperature, 0);
});

test("invalid Ling extras, protocol overrides and unverified reasoning flags fail before sending", async () => {
  const extras = [[], null, "text", 7, false, { model: "other" }, { messages: [] }, { stream: true }, { thinking: { type: "disabled" } },
    { reasoning_effort: "low" }, { enable_thinking: false }, { thinking_budget: 100 }, { max_tokens: 0 }, { max_tokens: 1.5 },
    { max_tokens: "8192" }, { temperature: -0.1 }, { temperature: 1.1 }, { top_p: 0 }, { top_p: 1.1 }];
  const hits = seen.length;
  for (const extra of extras) {
    configure(extra);
    const subject = `invalid-${generation}-${T}`;
    await assert.rejects(ask(subject));
    assert.deepEqual(await counts(subject), { receipts: 0, attempts: 0 });
  }
  configure(); process.env.ANT_LING_EXTRA_JSON = "{";
  await assert.rejects(ask(`bad-dedicated-json-${T}`, { model: "ling-3.1-flash" }), /JSON/);
  configure();
  for (const timeoutMs of [0, -1, 1.5, Number.NaN]) await assert.rejects(ask(`timeout-${T}`, { timeoutMs }));
  assert.equal(seen.length, hits);
});

test("json false and a caller parser use text output; conflicting extras fail before reservation", async () => {
  configure(); reply.content = "ready";
  let parses = 0;
  await ask(`plain-${T}`, { json: false, parse: (content) => { parses++; assert.equal(content, "ready"); return { ok: true }; } });
  assert.equal(parses, 1);
  assert.equal("response_format" in seen.at(-1)!.body, false);
  configure({ response_format: { type: "json_object" } });
  const subject = `format-conflict-${T}`;
  await assert.rejects(ask(subject, { json: false }), /conflict/);
  assert.deepEqual(await counts(subject), { receipts: 0, attempts: 0 });
});

test("usage, request ID, raw response and effective request summary are retained", async () => {
  configure({ max_tokens: 777, temperature: 0.6 }); reply.noId = true;
  const subject = `metadata-${T}`;
  const result = await ask(subject);
  assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
  const [row] = await sql`SELECT logical_key, request_id, response, usage, request FROM receipts WHERE id = ${result.receiptId}`;
  assert.equal(row!.request_id, `header-${T}`);
  assert.equal(row!.response.choices[0].message.reasoning_content, "private mock reasoning");
  assert.equal(typeof row!.response._latencyMs, "number");
  assert.deepEqual(row!.usage, result.usage);
  assert.equal(row!.request.bodyHash, sha256(JSON.stringify(seen.at(-1)!.body)));
  assert.equal(row!.logical_key, logicalKeyFor({ service: "llm", model: "Ling-3.1-flash", purpose: "ling_adaptation_test", subject,
    identity: { model: "Ling-3.1-flash", promptVersion: "ling-v1", system: sha256(system), user: sha256(`input ${subject}`),
      temperature: 0.6, maxTokens: 777, extra: { max_tokens: 777, temperature: 0.6 }, bodyHash: sha256(JSON.stringify(seen.at(-1)!.body)) } }));
});

test("truncation rejects even valid JSON before custom parsing and without a hidden paid retry", async () => {
  for (const content of ["", '{"ok":true}']) {
    configure(); reply = { content, finish: "length" };
    const hits = seen.length;
    let parses = 0;
    await assert.rejects(ask(`length-${generation}-${T}`, { parse: () => { parses++; return { ok: true }; } }), (error: unknown) => {
      assert.ok(error instanceof ModelOutputError);
      assert.equal(error.reason, "length");
      assert.ok(!error.message.includes("private mock reasoning"));
      return true;
    });
    assert.equal(parses, 0);
    assert.equal(seen.length, hits + 1);
    const [row] = await sql`SELECT id FROM receipts WHERE subject = ${`length-${generation}-${T}`}`;
    await failed(row!.id);
  }
});

test("empty, null, object and missing final answers never use reasoning or custom parser fallback", async () => {
  for (const output of ["empty", "null", "object", "missing"] as const) {
    configure(); reply = output === "missing" ? { missing: true } : { content: output === "empty" ? " " : output === "null" ? null : { ok: true } };
    const hits = seen.length;
    let parses = 0;
    await assert.rejects(ask(`empty-${output}-${T}`, { parse: () => { parses++; return { ok: true }; } }), (error: unknown) => {
      assert.ok(error instanceof ModelOutputError); assert.equal(error.reason, "empty"); return true;
    });
    assert.equal(parses, 0);
    assert.equal(seen.length, hits + 1);
    const [row] = await sql`SELECT id FROM receipts WHERE subject = ${`empty-${output}-${T}`}`;
    await failed(row!.id);
  }
});

test("invalid JSON, malformed envelopes and schema mismatch are saved failed outputs, without resending", async () => {
  for (const [name, answer, reason] of [["json", { content: "plain answer" }, "json"], ["envelope", { raw: "not JSON" }, "empty"],
    ["schema", { content: '{"ok":"wrong"}' }, "schema"]] as const) {
    configure(); reply = answer;
    const hits = seen.length;
    await assert.rejects(ask(`output-${name}-${T}`), (error: unknown) => {
      assert.ok(error instanceof ModelOutputError); assert.equal(error.reason, reason); return true;
    });
    assert.equal(seen.length, hits + 1);
    const [row] = await sql`SELECT id FROM receipts WHERE subject = ${`output-${name}-${T}`}`;
    await failed(row!.id);
  }
});

test("aliases share quota and cached responses despite quota changes and exhausted budget", async () => {
  configure();
  const subject = `cached-${T}`;
  const first = await ask(subject);
  const hits = seen.length;
  const [saved] = await sql`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'llm'`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('llm',0,0,0)
    ON CONFLICT (service) DO UPDATE SET per_minute=0, per_hour=0, per_day=0`;
  process.env.ANT_LING_QPS = "0.01"; process.env.ANT_LING_MAX_INFLIGHT = "2";
  try {
    assert.equal((await ask(subject, { model: "ling-3.1-flash" })).receiptId, first.receiptId);
    assert.equal(seen.length, hits);
    await assert.rejects(ask(`budget-${T}`), BudgetExceededError);
    assert.deepEqual(await counts(`budget-${T}`), { receipts: 0, attempts: 0 });
  } finally {
    if (saved) await sql`UPDATE budgets SET per_minute=${saved.per_minute}, per_hour=${saved.per_hour}, per_day=${saved.per_day} WHERE service='llm'`;
    else await sql`DELETE FROM budgets WHERE service='llm'`;
  }
  const quota = lingQuota(endpoint, process.env.LLM_API_KEY!, 85_000);
  assert.equal(quota.key, lingQuota(endpoint + "/chat/completions///", process.env.ANT_LING_API_KEY!, 85_000).key);
});

test("Ling quota defaults are conservative and explicit account groups join different credentials", () => {
  configure();
  const q = lingQuota(endpoint, "dummy-ling-key", 85_000);
  assert.equal(q.intervalMs, 1000); assert.equal(q.maxInflight, 1); assert.equal(q.leaseMs, 100_000);
  assert.notEqual(q.key, lingQuota(endpoint, "dummy-ling-different", 85_000).key);
  process.env.ANT_LING_QUOTA_GROUP = "isolated-common-account";
  assert.equal(lingQuota(endpoint, "dummy-ling-one", 85_000).key, lingQuota(endpoint, "dummy-ling-two", 85_000).key);
});

test("changing the Ling JSON protocol changes identity while the same protocol remains cached", async () => {
  configure();
  const subject = `json-identity-${T}`;
  const first = await ask(subject);
  const text = await ask(subject, { json: false });
  assert.notEqual(text.receiptId, first.receiptId);
  assert.equal((await ask(subject, { json: false })).receiptId, text.receiptId);
  assert.equal((await ask(subject, { json: true })).receiptId, first.receiptId);
});

test("environment JSON mode isolates a dedicated preset but official fallback inherits the same text protocol", async () => {
  configure(); process.env.LLM_JSON_MODE = "false";
  const subject = `env-json-${T}`;
  const text = await ask(subject);
  assert.equal("response_format" in seen.at(-1)!.body, false);
  const json = await ask(subject, { model: "ling-3.1-flash" });
  assert.notEqual(json.receiptId, text.receiptId);
  assert.deepEqual(seen.at(-1)!.body.response_format, { type: "json_object" });
  assert.equal((await ask(subject, { model: "ling-3.1-flash", json: false })).receiptId, text.receiptId);
  configure(); process.env.LLM_JSON_MODE = "false";
  delete process.env.ANT_LING_BASE_URL; delete process.env.ANT_LING_API_KEY;
  process.env.LLM_BASE_URL = "https://api.ant-ling.com/v1/chat/completions///";
  const fetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    assert.equal(String(url), "https://api.ant-ling.com/v1/chat/completions");
    return fetch(endpoint + "/chat/completions", init);
  };
  try {
    const first = await ask(`fallback-text-${T}`);
    assert.equal((await ask(`fallback-text-${T}`, { model: "ling-3.1-flash" })).receiptId, first.receiptId);
    assert.equal("response_format" in seen.at(-1)!.body, false);
  } finally { globalThis.fetch = fetch; }
});

test("HTTP 429 records one real failed attempt and shared Retry-After blocks an unsent alias", async () => {
  configure(); reply = { status: 429, headers: { "retry-after": "5" }, raw: '{"error":{"code":"rate_limit"}}' };
  const hits = seen.length;
  const subject = `sent429-${T}`;
  await assert.rejects(ask(subject), (error) => error instanceof ProviderRejectedError && error.status === 429 && error.retryAfterSeconds === 5);
  await assert.rejects(ask(`unsent429-${T}`, { model: "ling-3.1-flash" }), ProviderDeferredError);
  assert.equal(seen.length, hits + 1);
  const [row] = await sql`SELECT r.status, (SELECT count(*)::int FROM receipt_attempts a WHERE a.receipt_id=r.id AND a.status='failed') AS failed
    FROM receipts r WHERE subject=${subject}`;
  assert.deepEqual(row, { status: "failed", failed: 1 });
  assert.deepEqual(await counts(`unsent429-${T}`), { receipts: 0, attempts: 0 });
});

test("HTTP-date Retry-After and invalid-header fallback produce shared diagnostic cooldowns", async () => {
  for (const header of [new Date(Date.now() + 60_000).toUTCString(), "invalid"]) {
    configure(); reply = { status: 429, headers: { "retry-after": header }, raw: '{"error":"rate_limit"}' };
    await assert.rejects(ask(`retry-after-${generation}-${T}`), (error) => {
      assert.ok(error instanceof ProviderRejectedError);
      assert.ok(error.retryAfterSeconds! >= (header === "invalid" ? 30 : 50));
      assert.ok(error.retryAfterSeconds! <= (header === "invalid" ? 34 : 60));
      return true;
    });
  }
});

test("a real Ling quota wait parks in 0043 and resumes through actual pg-boss without an extra paid attempt", async () => {
  configure(); reply = { status: 429, headers: { "retry-after": "60" }, raw: '{"error":"rate_limit"}' };
  await assert.rejects(ask(`queue-cooldown-${T}`), ProviderRejectedError);
  const boss = await getBoss();
  const queue = `ling.resume.${T}`;
  await boss.createQueue(queue, { policy: "short", retryLimit: 2, expireInSeconds: 60 });
  const subject = `queue-resume-${T}`;
  const payload = { subject, attemptTag: `same-${T}`, reportDate: "2026-10-12" };
  const id = await boss.send(queue, payload, { singletonKey: subject, priority: 9, retentionSeconds: 300 });
  assert.ok(id);
  const [job] = await boss.fetch<typeof payload>(queue, { includeMetadata: true }); assert.ok(job);
  const waiting = await runProviderAwareJob(boss, job, () => ask(subject));
  assert.equal((waiting as { state: string }).state, "provider-deferred");
  assert.deepEqual(await counts(subject), { receipts: 0, attempts: 0 });
  const [parked] = await sql`SELECT status, remaining_retries FROM provider_deferred_jobs WHERE id=${id}`;
  assert.deepEqual(parked, { status: "waiting", remaining_retries: 2 });
  const quota = lingQuota(endpoint, process.env.LLM_API_KEY!, 85_000);
  await sql`UPDATE provider_quotas SET cooldown_until=now()-interval '1 second', next_start_at=now()-interval '1 second' WHERE quota_key=${quota.key}`;
  await sql`UPDATE provider_deferred_jobs SET resume_at=now()-interval '1 second' WHERE id=${id}`;
  reply = {};
  assert.equal((await resumeDeferredProviderJobs(boss)).dispatched, 1);
  const [continued] = await boss.fetch<typeof payload>(queue, { includeMetadata: true }); assert.ok(continued);
  assert.deepEqual(continued.data, payload); assert.equal(continued.priority, 9); assert.equal(continued.singletonKey, subject);
  const completed = await runProviderAwareJob(boss, continued, () => ask(subject));
  assert.deepEqual((completed as { data: unknown }).data, { ok: true });
  await boss.complete(queue, continued.id);
  assert.equal((await boss.getJobById(queue, continued.id))?.state, "completed");
  assert.deepEqual(await counts(subject), { receipts: 1, attempts: 1 });
  assert.equal((await sql`SELECT status FROM provider_deferred_jobs WHERE id=${id}`)[0]!.status, "finished");
});

test("unknown after an actual HTTP send stays protected even after its quota lease expires", async () => {
  configure();
  const subject = `unknown-${T}`;
  const fetch = globalThis.fetch;
  const hits = seen.length;
  globalThis.fetch = async (url, init) => { await fetch(url, init); throw new Error("mock lost response after send"); };
  try { await assert.rejects(ask(subject), /lost response/); } finally { globalThis.fetch = fetch; }
  assert.equal(seen.length, hits + 1);
  await assert.rejects(ask(subject), ReceiptUnknownError);
  const quota = lingQuota(endpoint, process.env.LLM_API_KEY!, 85_000);
  assert.equal((await sql`SELECT count(*)::int AS n FROM provider_quota_leases WHERE quota_key=${quota.key}`)[0]!.n, 1);
  await sql`UPDATE provider_quota_leases SET expires_at=now()-interval '1 second' WHERE quota_key=${quota.key}`;
  await assert.rejects(ask(subject, { model: "ling-3.1-flash" }), ReceiptUnknownError);
  assert.equal(seen.length, hits + 1);
  const [row] = await sql`SELECT r.status, a.status AS attempt FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id WHERE r.subject=${subject}`;
  assert.deepEqual(row, { status: "unknown", attempt: "unknown" });
});

test("real double scoring respects shared QPS with two distinct receipts and no business deferral", async () => {
  configure(); reply.score = true;
  const article: AnalyzeInputArticle = { id: `ling-double-${T}`, revision: 1, title: "虚构公司披露新增订单", url: "https://example.invalid/ling-double",
    author: null, publishedAt: new Date(), bodyText: "虚构公司披露有金额和履约期的订单。", excerpt: null, xPost: null, media: [],
    source: { name: "虚构财经来源", kind: "rss", tier: "T1", firstParty: false } };
  const hits = seen.length;
  const scores = await runSelectionScores(article, { scoreModel: "ling-3.1-flash", attemptTag: `test-${T}` });
  assert.deepEqual(scores!.values, [80, 80]);
  assert.equal(scores!.receiptIds.length, 2); assert.notEqual(scores!.receiptIds[0], scores!.receiptIds[1]);
  assert.equal(seen.length, hits + 2);
  assert.ok(seen.at(-1)!.at - seen.at(-2)!.at >= 990);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE receipt_id IN ${sql(scores!.receiptIds)}`)[0]!.n, 2);
});

test("invalid Ling quota settings and the model safety valve prevent any HTTP or paid reservation", async () => {
  configure(); const hits = seen.length;
  for (const [name, value] of [["ANT_LING_QPS", "0"], ["ANT_LING_QPS", "NaN"], ["ANT_LING_MAX_INFLIGHT", "1.5"]]) {
    process.env[name!] = value;
    await assert.rejects(ask(`invalid-quota-${name}-${T}`), /positive/);
    delete process.env[name!];
  }
  const enabled = config.modelCallsEnabled; config.modelCallsEnabled = false;
  try { await assert.rejects(ask(`disabled-${T}`), /disabled/); } finally { config.modelCallsEnabled = enabled; }
  assert.equal(seen.length, hits);
  assert.equal(process.env.COLLECT_ENABLED, "false"); assert.equal(process.env.FEISHU_INTERNAL_ENABLED, "false");
  assert.equal(config.feishuContentPushEnabled, false); assert.equal(config.indexNowSubmitEnabled, false);
});
