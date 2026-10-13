// Additional compatibility guards; the original 13 GLM regressions stay unchanged.
import { stub, Reply, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import { chatJson, ModelOutputError } from "@aihot/backend/providers/llm";
import { ProviderRejectedError, logicalKeyFor } from "@aihot/backend/providers/receipts";
import { sha256 } from "@aihot/backend/lib/ids";

const T = tag();
const seen: Record<string, unknown>[] = [];
let status = 200;
let content = '{"ok":true}';
const provider = await stub((_hit, req) => {
  seen.push(JSON.parse(req.body));
  return status === 200 ? { choices: [{ finish_reason: "stop", message: { content } }] } : new Reply(status, { error: "mock provider rejected" });
});
Object.assign(process.env, { LLM_BASE_URL: provider.url + "/v1", LLM_API_KEY: `dummy-compatible-${T}`, LLM_MODEL: "glm-5.3-flash" });
for (const name of ["ZHIPU", "DEEPSEEK", "DASHSCOPE", "XIAOMI_MIMO"]) {
  process.env[`${name}_BASE_URL`] = provider.url + "/v1";
  process.env[`${name}_API_KEY`] = `dummy-compatible-${T}`;
}
after(async () => { await provider.close(); await closeDb(); });

function ask(subject: string, model = "default") {
  return chatJson({ model, purpose: "ling_compatibility", subject, promptVersion: "compat-v1", system: "return JSON", user: subject,
    maxTokens: 512, schema: z.object({ ok: z.boolean() }) });
}

test("named GLM, DeepSeek, Qwen and MiMo ignore Ling quota configuration and preserve their extras", async () => {
  process.env.ANT_LING_QPS = "invalid"; process.env.ANT_LING_MAX_INFLIGHT = "invalid";
  const [before] = await sql`SELECT count(*)::int AS n FROM provider_quotas`;
  for (const [model, tokens, extra] of [
    ["glm-5.3-flash", 4096, { thinking: { type: "enabled" }, reasoning_effort: "low" }],
    ["glm-5.3-flash-selection", 4096, { thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "high", top_p: 0.95 }],
    ["deepseek-flash", 512, { thinking: { type: "disabled" } }],
    ["deepseek-flash-think", 4512, {}],
    ["qwen3.7-flash", 512, { enable_thinking: false }],
    ["qwen3.8-flash", 512, { enable_thinking: false }],
    ["mimo-v2.6-flash", 512, { thinking: { type: "disabled" } }],
    ["qwen3-vl-flash", 512, { enable_thinking: false }],
  ] as const) {
    await ask(`named-${model}-${T}`, model);
    const body = seen.at(-1)!;
    assert.equal(body.max_tokens, tokens);
    for (const [field, value] of Object.entries(extra)) assert.deepEqual(body[field], value);
    assert.equal("response_format" in body, model !== "qwen3-vl-flash");
  }
  assert.equal((await sql`SELECT count(*)::int AS n FROM provider_quotas`)[0]!.n, before!.n);
});

test("GLM HTTP 429 retains its original retry path and does not become shared quota waiting", async () => {
  status = 429;
  const subject = `glm-429-${T}`;
  const hits = provider.hits();
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const response = await fetch(url, init);
    return new Response(await response.text(), { status: response.status, headers: { "retry-after": "60" } });
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(ask(subject), (error) => {
      assert.ok(error instanceof ProviderRejectedError);
      assert.equal(error.status, 429); assert.equal(error.retryable, true); assert.equal(error.retryAfterSeconds, undefined);
      return true;
    });
  } finally { globalThis.fetch = fetch; status = 200; }
  assert.equal(provider.hits(), hits + 2, "the caller's existing retry is not replaced with a Ling cooldown");
  const rows = await sql`SELECT a.status FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE r.subject=${subject}`;
  assert.deepEqual(rows.map((r) => r.status), ["failed", "failed"]);
});

test("other default models retain legacy extras, summary and receipt identity", async () => {
  process.env.LLM_MODEL = "custom-compatible";
  const extra = { max_tokens: 900, temperature: 0.7, custom_field: true };
  process.env.LLM_EXTRA_JSON = JSON.stringify(extra);
  const subject = `legacy-identity-${T}`;
  const result = await ask(subject);
  assert.equal(seen.at(-1)!.max_tokens, 900);
  const [row] = await sql`SELECT request,logical_key FROM receipts WHERE id=${result.receiptId}`;
  assert.equal("bodyHash" in row!.request, false);
  assert.equal("model" in row!.request, false);
  assert.equal(row!.request.maxTokens, 512, "non-Ling retains the original identity semantics for operator extras");
  assert.equal(row!.logical_key, logicalKeyFor({ service: "llm", model: "custom-compatible", purpose: "ling_compatibility", subject,
    identity: { model: "custom-compatible", promptVersion: "compat-v1", system: sha256("return JSON"), user: sha256(subject),
      temperature: 0.2, maxTokens: 512, extra } }));
  delete process.env.LLM_EXTRA_JSON;
});

test("GLM output failures keep their existing error behavior and do not inherit Ling-only classification", async () => {
  process.env.LLM_MODEL = "glm-5.3-flash"; content = "";
  await assert.rejects(ask(`glm-empty-${T}`), (error) => {
    assert.ok(error instanceof ModelOutputError); assert.equal(error.reason, null); assert.match(error.message, /final answer is empty/); return true;
  });
  content = '{"ok":true}';
});
