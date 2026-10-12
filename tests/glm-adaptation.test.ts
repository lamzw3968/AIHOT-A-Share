// GLM compatibility uses only an isolated loopback provider and the real receipt/budget path.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { sha256 } from "@aihot/backend/lib/ids";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { chatJson, ModelOutputError } from "@aihot/backend/providers/llm";
import { BudgetExceededError, logicalKeyFor } from "@aihot/backend/providers/receipts";

const T = tag();
const seen: Array<{ text: string; body: Record<string, unknown> }> = [];
let mode: "ok" | "length" | "length-json" | "empty" | "null" | "object" | "missing" | "json" | "schema" = "ok";
const provider = await stub((hit, req) => {
  assert.equal(req.url, "/v1/chat/completions");
  const body = JSON.parse(req.body) as Record<string, unknown>;
  seen.push({ text: req.body, body });
  const content = mode === "length" || mode === "empty" ? ""
    : mode === "null" ? null : mode === "object" ? { ok: true } : mode === "missing" ? undefined
    : mode === "json" ? "{broken" : mode === "schema" ? '{"ok":"wrong"}' : '{"ok":true}';
  return {
    id: "glm-adaptation-" + T + "-" + hit,
    choices: [{ finish_reason: mode.startsWith("length") ? "length" : "stop", message: {
      content, reasoning_content: mode === "length" || mode === "empty" ? '{"ok":true}' : "private stub reasoning",
    } }],
    usage: { prompt_tokens: 10, completion_tokens: mode.startsWith("length") ? body.max_tokens : 20, total_tokens: 30 },
  };
});
Object.assign(process.env, {
  LLM_BASE_URL: provider.url + "/v1", LLM_API_KEY: "dummy-glm-test-key",
  ZHIPU_BASE_URL: provider.url + "/v1", ZHIPU_API_KEY: "dummy-glm-test-key",
  DEEPSEEK_BASE_URL: provider.url + "/v1", DEEPSEEK_API_KEY: "dummy-glm-test-key",
  LLM_JSON_MODE: "true", LLM_VISION: "false",
});
const system = "Return only the requested test JSON.";
const promptVersion = "glm-adaptation-v1";
const schema = z.object({ ok: z.boolean() });
function configure(model = "glm-5.3-flash", extra?: unknown) {
  process.env.LLM_MODEL = model;
  if (extra === undefined) delete process.env.LLM_EXTRA_JSON;
  else process.env.LLM_EXTRA_JSON = JSON.stringify(extra);
  mode = "ok";
}
function ask(subject: string, maxTokens = 512, model = "default", json?: boolean) {
  return chatJson({ model, purpose: "glm_adaptation_test", subject, promptVersion, system,
    user: "input " + subject, schema, maxTokens, temperature: 0.2, json });
}
async function audit(id: number, subject: string, extra: unknown, service = "llm") {
  const sent = seen.at(-1)!;
  const [receipt] = await sql<{ logical_key: string; request: Record<string, unknown> }[]>`
    SELECT logical_key, request FROM receipts WHERE id = ${id}`;
  assert.equal(receipt!.request.maxTokens, sent.body.max_tokens);
  assert.equal(receipt!.request.temperature, sent.body.temperature);
  assert.equal(receipt!.request.model, sent.body.model);
  assert.equal(receipt!.request.bodyHash, sha256(sent.text));
  assert.equal(receipt!.logical_key, logicalKeyFor({ service, model: String(sent.body.model),
    purpose: "glm_adaptation_test", subject, identity: { model: sent.body.model, promptVersion,
      system: sha256(system), user: sha256("input " + subject), temperature: sent.body.temperature,
      maxTokens: sent.body.max_tokens, extra } }));
}
async function auditLegacy(id: number, subject: string, extra: unknown, maxTokens: number, model = "non-glm-test-model", service = "llm") {
  const [receipt] = await sql<{ logical_key: string; request: Record<string, unknown> }[]>`
    SELECT logical_key, request FROM receipts WHERE id = ${id}`;
  assert.deepEqual(receipt!.request, { promptVersion, systemHash: sha256(system),
    userHash: sha256("input " + subject), userChars: ("input " + subject).length, temperature: 0.2, maxTokens });
  assert.equal(receipt!.logical_key, logicalKeyFor({ service, model,
    purpose: "glm_adaptation_test", subject, identity: { model, promptVersion,
      system: sha256(system), user: sha256("input " + subject), temperature: 0.2, maxTokens, extra } }));
}
async function counts() {
  const [row] = await sql<{ receipts: number; attempts: number }[]>`
    SELECT (SELECT count(*)::int FROM receipts) AS receipts,
           (SELECT count(*)::int FROM receipt_attempts) AS attempts`;
  return row;
}
async function failedReceipt(id: number) {
  const [receipt] = await sql<{ status: string; response: Record<string, unknown> }[]>`
    SELECT status, response FROM receipts WHERE id = ${id}`;
  assert.equal(receipt!.status, "failed");
  const [attempts] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts WHERE receipt_id = ${id}`;
  assert.equal(attempts!.n, 1);
  return receipt!.response;
}

after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("default identifies the actual GLM model, supplies low reasoning and bounded short-task output", async () => {
  configure();
  for (const limit of [512, 800, 1024, 16_384]) {
    const subject = "glm-default-" + limit + "-" + T;
    const result = await ask(subject, limit);
    assert.deepEqual(result.data, { ok: true });
    const body = seen.at(-1)!.body;
    assert.equal(body.model, "glm-5.3-flash");
    assert.deepEqual(body.thinking, { type: "enabled" });
    assert.equal(body.reasoning_effort, "low");
    assert.equal(body.max_tokens, Math.max(limit, 4096));
    assert.deepEqual(body.response_format, { type: "json_object" });
    await audit(result.receiptId, subject, { thinking: { type: "enabled" }, reasoning_effort: "low" });
    const hits = provider.hits();
    const reused = await ask(subject, limit);
    assert.equal(reused.receiptId, result.receiptId);
    assert.equal(reused.reused, true);
    assert.equal(provider.hits(), hits, "same adapted request reuses its saved response");
  }
});

test("GLM 5.3 family recognition is case insensitive and follows the actual default model", async () => {
  for (const model of ["glm-5.3", "GLM-5.3-FLASH", "glm-5.3-flashx"]) {
    configure(model);
    const subject = "glm-family-" + model + "-" + T;
    const result = await ask(subject, 800);
    assert.equal(seen.at(-1)!.body.model, model);
    assert.equal(seen.at(-1)!.body.max_tokens, 4096);
    await audit(result.receiptId, subject, { thinking: { type: "enabled" }, reasoning_effort: "low" });
  }
});

test("named GLM presets keep low/high effort and the selection model's existing large allowance", async () => {
  configure();
  const low = "glm-named-low-" + T;
  await audit((await ask(low, 800, "glm-5.3-flash")).receiptId, low,
    { thinking: { type: "enabled" }, reasoning_effort: "low" }, "zhipu");
  assert.equal(seen.at(-1)!.body.max_tokens, 4096);
  const high = "glm-named-high-" + T;
  await audit((await ask(high, 65_536, "glm-5.3-flash-selection")).receiptId, high,
    { thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "high", top_p: 0.95 }, "zhipu");
  assert.equal(seen.at(-1)!.body.max_tokens, 65_536);
});

test("non-GLM models retain original output limits, preset extras and receipt identities", async () => {
  for (const model of ["non-glm-test-model", "glm-4.7", "glm-5.3-flash-custom"]) {
    configure(model);
    for (const limit of [64, 800, 16_384]) {
      const subject = "non-glm-" + model + "-" + limit + "-" + T;
      const result = await ask(subject, limit);
      assert.equal(seen.at(-1)!.body.max_tokens, Math.max(limit, 512));
      assert.ok(!("thinking" in seen.at(-1)!.body));
      assert.ok(!("reasoning_effort" in seen.at(-1)!.body));
      await auditLegacy(result.receiptId, subject, null, Math.max(limit, 512), model);
      const hits = provider.hits();
      assert.equal((await ask(subject, limit)).receiptId, result.receiptId);
      assert.equal(provider.hits(), hits);
    }
  }
  configure();
  const subject = "non-glm-think-" + T;
  const result = await ask(subject, 800, "deepseek-flash-think");
  assert.equal(seen.at(-1)!.body.max_tokens, 4800);
  await auditLegacy(result.receiptId, subject, null, 4800, "deepseek-flash", "deepseek");
});

test("non-GLM operator extras retain baseline construction, validation and cache behavior", async () => {
  const extras = [null, [], "text", 7, { max_tokens: null, temperature: "legacy" },
    { model: "gateway-alias", messages: [], stream: false, max_tokens: 777, temperature: 0.6, response_format: { type: "json_object" } }];
  for (const [index, extra] of extras.entries()) {
    configure("non-glm-test-model", extra);
    const subject = "non-glm-extra-" + index + "-" + T;
    const result = await ask(subject, 800, "default", false);
    assert.deepEqual(result.data, { ok: true });
    await auditLegacy(result.receiptId, subject, extra, 800);
    const hits = provider.hits();
    assert.equal((await ask(subject, 800, "default", false)).receiptId, result.receiptId);
    assert.equal(provider.hits(), hits);
  }
  assert.equal(seen.at(-1)!.body.model, "gateway-alias");
  assert.deepEqual(seen.at(-1)!.body.messages, []);
  assert.equal(seen.at(-1)!.body.max_tokens, 777);
  assert.equal(seen.at(-1)!.body.temperature, 0.6);
  assert.deepEqual(seen.at(-1)!.body.response_format, { type: "json_object" });
  configure("non-glm-test-model");
  process.env.LLM_EXTRA_JSON = "{";
  const before = await counts();
  await assert.rejects(ask("non-glm-invalid-json-" + T), /LLM_EXTRA_JSON must be a JSON object/);
  assert.deepEqual(await counts(), before);
});

test("valid GLM operator extras win and effective parameters match the body and receipt", async () => {
  const extra = { thinking: { clear_thinking: false }, reasoning_effort: "high", max_tokens: 8192, temperature: 0.7, top_p: 0.9 };
  configure("glm-5.3-flash", extra);
  const subject = "glm-extra-" + T;
  const result = await ask(subject);
  assert.equal(seen.at(-1)!.body.max_tokens, 8192);
  assert.equal(seen.at(-1)!.body.temperature, 0.7);
  assert.equal(seen.at(-1)!.body.reasoning_effort, "high");
  await audit(result.receiptId, subject, { ...extra, thinking: { type: "enabled", clear_thinking: false } });
  for (const maxTokens of [512, 131_072]) {
    configure("glm-5.3-flash", { max_tokens: maxTokens, temperature: 0, reasoning_effort: "max" });
    const current = "glm-explicit-" + maxTokens + "-" + T;
    await audit((await ask(current)).receiptId, current,
      { thinking: { type: "enabled" }, reasoning_effort: "max", max_tokens: maxTokens, temperature: 0 });
    assert.equal(seen.at(-1)!.body.max_tokens, maxTokens, "an explicit valid operator limit remains authoritative");
  }
  configure("glm-5.3-flash", { response_format: { type: "text" } });
  await ask("glm-explicit-text-" + T, 512, "default", false);
  assert.deepEqual(seen.at(-1)!.body.response_format, { type: "text" });
});

test("invalid GLM extras and protocol overrides fail before any receipt, attempt or provider request", async () => {
  const hits = provider.hits();
  const before = await counts();
  for (const extra of [[], null, "text", 7, false, { model: "different" }, { messages: [] }, { stream: true },
    { max_tokens: 0 }, { max_tokens: null }, { max_tokens: 1.5 }, { max_tokens: "8192" }, { max_tokens: 131_073 },
    { temperature: null }, { temperature: "0.2" }, { thinking: null }, { thinking: [] },
    { thinking: { type: "disabled" } }, { reasoning_effort: "none" }]) {
    configure("glm-5.3-flash", extra);
    await assert.rejects(ask("invalid-extra-" + T));
  }
  configure("glm-5.3-flash", { response_format: { type: "json_object" } });
  await assert.rejects(ask("json-mode-" + T, 512, "default", false), /conflicts/);
  configure();
  process.env.LLM_EXTRA_JSON = "{";
  await assert.rejects(ask("invalid-json-" + T), /LLM_EXTRA_JSON must be a JSON object/);
  assert.equal(provider.hits(), hits);
  assert.deepEqual(await counts(), before);
});

test("truncated reasoning-only GLM output is saved as failed without an implicit paid retry", async () => {
  configure();
  mode = "length";
  const subject = "glm-truncated-" + T;
  const hits = provider.hits();
  let receiptId: number | null = null;
  await assert.rejects(ask(subject), (error: unknown) => {
    assert.ok(error instanceof ModelOutputError);
    assert.match(error.message, /truncated/);
    assert.ok(!error.message.includes("private stub reasoning"));
    receiptId = error.receiptId;
    return true;
  });
  assert.equal(provider.hits(), hits + 1);
  const response = await failedReceipt(receiptId!);
  const choice = (response.choices as Array<{ message: { content: string; reasoning_content: string } }>)[0]!;
  assert.equal(choice.message.content, "");
  assert.equal(choice.message.reasoning_content, '{"ok":true}');
});

test("a GLM length finish rejects even parseable JSON before the caller's parser runs", async () => {
  configure();
  mode = "length-json";
  const hits = provider.hits();
  let parses = 0;
  let receiptId: number | null = null;
  await assert.rejects(chatJson({ model: "default", purpose: "glm_adaptation_test", subject: "glm-valid-truncated-" + T,
    promptVersion, system, user: "truncated " + T, schema, parse: () => { parses++; return { ok: true }; } }), (error: unknown) => {
    assert.ok(error instanceof ModelOutputError);
    assert.match(error.message, /truncated/);
    receiptId = error.receiptId;
    return true;
  });
  assert.equal(parses, 0);
  assert.equal(provider.hits(), hits + 1);
  const response = await failedReceipt(receiptId!);
  assert.equal((response.choices as Array<{ message: { content: string } }>)[0]!.message.content, '{"ok":true}');
});

test("GLM empty, missing and non-string final answers never fall back to reasoning or custom parsing", async () => {
  configure();
  for (const output of ["empty", "null", "object", "missing"] as const) {
    mode = output;
    const hits = provider.hits();
    let parses = 0;
    let receiptId: number | null = null;
    await assert.rejects(chatJson({ model: "default", purpose: "glm_adaptation_test", subject: "glm-empty-" + output + "-" + T,
      promptVersion, system, user: "empty " + output + " " + T, schema, parse: () => { parses++; return { ok: true }; } }), (error: unknown) => {
      assert.ok(error instanceof ModelOutputError);
      assert.match(error.message, /final answer is empty/);
      receiptId = error.receiptId;
      return true;
    });
    assert.equal(parses, 0);
    assert.equal(provider.hits(), hits + 1);
    await failedReceipt(receiptId!);
  }
});

test("non-GLM length and empty output retain the original JSON and custom-parser behavior", async () => {
  configure("non-glm-test-model");
  mode = "length-json";
  assert.deepEqual((await ask("non-glm-length-" + T)).data, { ok: true });
  for (const output of ["empty", "null", "missing"] as const) {
    mode = output;
    let parses = 0;
    const result = await chatJson({ model: "default", purpose: "glm_adaptation_test", subject: "non-glm-empty-" + output + "-" + T,
      promptVersion, system, user: output, schema, parse: (content) => {
        parses++; assert.equal(content, ""); return { ok: true };
      } });
    assert.deepEqual(result.data, { ok: true });
    assert.equal(parses, 1);
  }
});

test("GLM JSON/schema validation and the model safety valve remain enforced", async () => {
  configure();
  for (const output of ["json", "schema"] as const) {
    mode = output;
    const hits = provider.hits();
    let receiptId: number | null = null;
    await assert.rejects(ask("glm-" + output + "-" + T), (error: unknown) => {
      assert.ok(error instanceof ModelOutputError);
      receiptId = error.receiptId;
      return true;
    });
    assert.equal(provider.hits(), hits + 1);
    await failedReceipt(receiptId!);
  }
  const enabled = config.modelCallsEnabled;
  config.modelCallsEnabled = false;
  try {
    const hits = provider.hits();
    const before = await counts();
    await assert.rejects(ask("glm-disabled-" + T), /disabled/);
    assert.equal(provider.hits(), hits);
    assert.deepEqual(await counts(), before);
  } finally { config.modelCallsEnabled = enabled; }
  assert.equal(process.env.COLLECT_ENABLED, "false");
  assert.equal(config.feishuContentPushEnabled, false);
  assert.equal(process.env.FEISHU_INTERNAL_ENABLED, "false");
  assert.equal(config.indexNowSubmitEnabled, false);
});

test("adapted GLM requests still pass through the paid-service budget before sending", async () => {
  configure();
  const [saved] = await sql<{ per_minute: number; per_hour: number; per_day: number }[]>`
    SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'llm'`;
  await sql`INSERT INTO budgets (service,per_minute,per_hour,per_day) VALUES ('llm',0,0,0)
    ON CONFLICT (service) DO UPDATE SET per_minute=0,per_hour=0,per_day=0`;
  try {
    const hits = provider.hits();
    const before = await counts();
    await assert.rejects(ask("glm-budget-" + T), BudgetExceededError);
    assert.equal(provider.hits(), hits);
    assert.deepEqual(await counts(), before);
  } finally {
    if (saved) await sql`UPDATE budgets SET per_minute=${saved.per_minute},per_hour=${saved.per_hour},per_day=${saved.per_day} WHERE service='llm'`;
    else await sql`DELETE FROM budgets WHERE service='llm'`;
  }
});

