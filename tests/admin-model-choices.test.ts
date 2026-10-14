// Admin reads use the real database/API and deliberately have no usable model credentials.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { AdminModels } from "@aihot/contracts/admin";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { modelsOverview, switchModel } from "@aihot/backend/admin/models";
import { CAPABILITIES, invalidateModelCache, modelFor, modelSources, type CapabilityKey } from "@aihot/backend/editorial/models";
import { MODELS } from "@aihot/backend/providers/llm";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const actor = `admin-model-test-${T}`;
const capabilities = Object.keys(CAPABILITIES) as CapabilityKey[];
const settingKeys = capabilities.map((key) => `models.${key}`);
const savedConfig = { modelCallsEnabled: config.modelCallsEnabled, devAdmin: config.devAdmin, environmentName: config.environmentName };
const envNames = ["LLM_MODEL", "LLM_BASE_URL", "LLM_API_KEY", "LLM_EXTRA_JSON", "LLM_VISION", "ANT_LING_BASE_URL", "ANT_LING_API_KEY", "ANT_LING_EXTRA_JSON", "ANT_LING_QPS", ...Object.values(CAPABILITIES).map((c) => c.env)];
const savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));
let savedSettings: Array<{ key: string; value: unknown; updated_by: string | null; updated_at: Date }> = [];

function configure() {
  for (const c of Object.values(CAPABILITIES)) delete process.env[c.env];
  Object.assign(process.env, { LLM_MODEL: "Ling-3.1-flash", LLM_BASE_URL: `http://127.0.0.1:9/private-endpoint-${T}`,
    LLM_EXTRA_JSON: `{invalid-extra-${T}`, LLM_VISION: "false", ANT_LING_EXTRA_JSON: `{invalid-ling-extra-${T}`, ANT_LING_QPS: "invalid" });
  for (const name of Object.keys(process.env)) if (name.endsWith("_API_KEY")) delete process.env[name];
  config.modelCallsEnabled = false;
  config.devAdmin = null;
  config.environmentName = "test";
}

async function paidCounts() {
  const [row] = await sql`SELECT (SELECT count(*)::int FROM receipts) AS receipts,
    (SELECT count(*)::int FROM receipt_attempts) AS attempts,
    (SELECT count(*)::int FROM provider_quotas) AS quotas,
    (SELECT count(*)::int FROM provider_quota_leases) AS leases,
    (SELECT count(*)::int FROM provider_deferred_jobs) AS deferred`;
  return row!;
}

function choice(overview: Awaited<ReturnType<typeof modelsOverview>>, key: string) {
  const found = overview.choices.find((c) => c.key === key);
  assert.ok(found, `missing registered model ${key}`);
  return found;
}

before(async () => {
  savedSettings = await sql`SELECT key,value,updated_by,updated_at FROM settings WHERE key IN ${sql(settingKeys)}`;
});
beforeEach(async () => {
  configure();
  await sql`DELETE FROM settings WHERE key IN ${sql(settingKeys)}`;
  invalidateModelCache();
});
after(async () => {
  await sql`DELETE FROM settings WHERE key IN ${sql(settingKeys)}`;
  for (const row of savedSettings) await sql`INSERT INTO settings (key,value,updated_by,updated_at)
    VALUES (${row.key},${sql.json(row.value as never)},${row.updated_by},${row.updated_at})`;
  invalidateModelCache();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  Object.assign(config, savedConfig);
  await closeDb();
});

test("choices extend the legacy contract without changing keys, services or vision flags", async () => {
  const legacy: AdminModels["choices"][number] = { key: "default", service: "llm", vision: false };
  assert.deepEqual(Object.keys(legacy).sort(), ["key", "service", "vision"]);
  const overview = await modelsOverview();
  assert.deepEqual(overview.choices.map((c) => c.key).sort(), Object.keys(MODELS).sort());
  for (const item of overview.choices) {
    assert.deepEqual(Object.keys(item).sort(), ["key", "label", "model", "provider", "service", "vision"]);
    assert.equal(item.service, MODELS[item.key]!.service);
    assert.equal(item.vision, !!MODELS[item.key]!.vision);
    assert.equal(typeof item.label, "string");
  }
});

test("default and named Ling expose actual models without keys, request extras, endpoints or paid side effects", async (t) => {
  process.env.LLM_API_KEY = `dummy-admin-secret-${T}`;
  process.env.ANT_LING_API_KEY = `dummy-dedicated-secret-${T}`;
  process.env.ANT_LING_BASE_URL = `http://127.0.0.1:9/dedicated-${T}`;
  const baseline = await paidCounts();
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => { fetches++; throw new Error("admin model listing must not fetch"); });
  for (const withKeys of [true, false]) {
    if (!withKeys) { delete process.env.LLM_API_KEY; delete process.env.ANT_LING_API_KEY; }
    const overview = await modelsOverview();
    const current = choice(overview, "default");
    const ling = choice(overview, "ling-3.1-flash");
    assert.equal(current.model, "Ling-3.1-flash"); assert.equal(current.provider, "ant-ling");
    assert.equal(current.label, "default → Ling-3.1-flash (ant-ling)");
    assert.equal(ling.model, "Ling-3.1-flash"); assert.equal(ling.provider, "ant-ling");
    assert.equal(ling.label, "Ling-3.1-flash (ant-ling)"); assert.equal(ling.service, "llm"); assert.equal(ling.vision, false);
    const payload = JSON.stringify(overview);
    for (const forbidden of [`dummy-admin-secret-${T}`, `dummy-dedicated-secret-${T}`, `private-endpoint-${T}`, `dedicated-${T}`,
      `invalid-extra-${T}`, `invalid-ling-extra-${T}`, "apiKey", "baseUrlEnv", "apiKeyEnv"]) assert.equal(payload.includes(forbidden), false);
  }
  assert.equal(fetches, 0); assert.deepEqual(await paidCounts(), baseline);
});

test("parameter aliases remain distinguishable while identifying the actual provider model", async () => {
  const overview = await modelsOverview();
  const glm = choice(overview, "glm-5.3-flash");
  const selection = choice(overview, "glm-5.3-flash-selection");
  assert.equal(glm.label, "glm-5.3-flash (zhipu)");
  assert.equal(selection.label, "glm-5.3-flash-selection → glm-5.3-flash (zhipu)");
  assert.equal(selection.model, glm.model); assert.notEqual(selection.label, glm.label);
  const deepseek = choice(overview, "deepseek-flash");
  const thinking = choice(overview, "deepseek-flash-think");
  assert.equal(thinking.label, "deepseek-flash-think → deepseek-flash (deepseek)");
  assert.equal(thinking.model, deepseek.model); assert.notEqual(thinking.label, deepseek.label);
  assert.equal(choice(overview, "qwen3.7-flash").provider, "dashscope");
  assert.equal(choice(overview, "qwen3.8-flash").provider, "dashscope");
  assert.equal(choice(overview, "mimo-v2.6-flash").provider, "mimo");
  assert.equal(choice(overview, "qwen3-vl-flash").vision, true);
});

test("default presentation follows live configuration and canonical Ling casing without requiring credentials", async () => {
  for (const [model, provider] of [["lING-3.1-FLASH", "ant-ling"], ["glm-5.3-flash", "zhipu"], ["deepseek-flash", "deepseek"], ["qwen3.7-flash", "dashscope"], ["mimo-v2.6-flash", "mimo"]]) {
    process.env.LLM_MODEL = model;
    const current = choice(await modelsOverview(), "default");
    assert.equal(current.model, model.toLowerCase() === "ling-3.1-flash" ? "Ling-3.1-flash" : model);
    assert.equal(current.provider, provider);
  }
  delete process.env.LLM_MODEL;
  assert.match(choice(await modelsOverview(), "default").label!, /default.*未配置模型/);
});

test("unknown default model names only use exact official hosts to identify a provider", async () => {
  process.env.LLM_MODEL = "deployment-alias";
  for (const [endpoint, provider] of [["https://api.ant-ling.com/v1", "ant-ling"], ["https://open.bigmodel.cn/api/paas/v4", "zhipu"],
    ["https://api.ant-ling.com.evil.invalid/v1", "openai-compatible"], ["http://127.0.0.1:9/v1", "openai-compatible"], ["invalid URL", "openai-compatible"]]) {
    process.env.LLM_BASE_URL = endpoint;
    const current = choice(await modelsOverview(), "default");
    assert.equal(current.provider, provider); assert.equal(current.model, "deployment-alias");
    assert.equal(current.label!.includes(endpoint), false);
  }
});

test("provider display honors a synthetic grouped endpoint without returning any grouped credential", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "aihot-admin-models-fake-credentials-"));
  writeFileSync(path.join(directory, "models.env"), `LLM_BASE_URL=https://api.ant-ling.com/private-fake-route-${T}\nLLM_API_KEY=dummy-group-secret-${T}\n`);
  const program = `
    import assert from 'node:assert/strict';
    import { modelsOverview } from '@aihot/backend/admin/models';
    import { closeDb, sql } from '@aihot/backend/db';
    assert.match(new URL(process.env.DATABASE_URL).pathname, /_(test|ci)$/);
    const before = await sql\x60SELECT count(*)::int AS n FROM receipt_attempts\x60;
    const overview = await modelsOverview();
    const shown = overview.choices.find(c => c.key === 'default');
    assert.equal(shown.provider, 'ant-ling');
    assert.equal(shown.model, 'synthetic-deployment-alias');
    assert.ok(!JSON.stringify(overview).includes('dummy-group-secret'));
    assert.ok(!JSON.stringify(overview).includes('private-fake-route'));
    assert.deepEqual(await sql\x60SELECT count(*)::int AS n FROM receipt_attempts\x60, before);
    await closeDb();
    console.log(JSON.stringify(shown));
  `;
  const env: NodeJS.ProcessEnv = { ...process.env, AIHOT_CREDENTIALS_DIR: directory, MODEL_CALLS_ENABLED: "false", LLM_MODEL: "synthetic-deployment-alias" };
  delete env.LLM_BASE_URL; delete env.LLM_API_KEY;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", program], { cwd: process.cwd(), env, encoding: "utf8", timeout: 20_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).label, "default → synthetic-deployment-alias (ant-ling)");
});

test("all eleven capabilities keep admin over environment over code-default routing and immediate cache invalidation", async () => {
  assert.deepEqual(capabilities, ["prefilter", "score", "understand", "summarize", "structure", "group", "groupReview", "digest", "report", "translate", "monitor"]);
  const baseline = await paidCounts();
  for (const key of capabilities) {
    const c = CAPABILITIES[key];
    assert.equal(await modelFor(key), c.default);
    assert.deepEqual((await modelSources())[key], { model: c.default, source: "default" });
    process.env[c.env] = "glm-5.3-flash";
    assert.equal(await modelFor(key), "glm-5.3-flash");
    assert.deepEqual((await modelSources())[key], { model: "glm-5.3-flash", source: "env" });
    const changed = await switchModel(key, "ling-3.1-flash", "isolated admin override", actor);
    assert.deepEqual(changed.before, { model: "glm-5.3-flash", source: "env" });
    assert.deepEqual(changed.after, { model: "ling-3.1-flash", source: "admin" });
    assert.equal(await modelFor(key), "ling-3.1-flash", "a primed cache must refresh on switch");
    const restored = await switchModel(key, null, "restore capability environment", actor);
    assert.deepEqual(restored.after, { model: "glm-5.3-flash", source: "env" });
    assert.equal(await modelFor(key), "glm-5.3-flash");
    delete process.env[c.env];
    assert.equal(await modelFor(key), c.default);
  }
  const overview = await modelsOverview();
  assert.equal(overview.capabilities.length, 11);
  for (const c of overview.capabilities) {
    assert.equal(c.env, CAPABILITIES[c.key as CapabilityKey].env);
    assert.equal(c.defaultModel, CAPABILITIES[c.key as CapabilityKey].default);
    assert.deepEqual(c.current, { model: c.defaultModel, source: "default" });
  }
  const rows = await sql`SELECT subject,before,after FROM audit_log WHERE action='models.switch' AND actor=${actor}`;
  assert.equal(rows.length, 22);
  for (const key of capabilities) assert.equal(rows.filter((row) => row.subject === `capability:${key}`).length, 2);
  assert.deepEqual(await paidCounts(), baseline);
});

test("switching validates capability, model, reason and vision without modifying settings or audit on rejection", async () => {
  const [initial] = await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='models.switch' AND actor=${actor}`;
  for (const [capability, model, reason] of [["missing", "ling-3.1-flash", "invalid capability"], ["score", "missing", "invalid model"],
    ["score", "ling-3.1-flash", "  "], ["score", "qwen3-vl-flash", "vision mismatch"]] as const) {
    await assert.rejects(switchModel(capability, model, reason, actor), (error: unknown) => (error as { statusCode: number }).statusCode === 400);
  }
  assert.equal((await sql`SELECT count(*)::int AS n FROM settings WHERE key IN ${sql(settingKeys)}`)[0]!.n, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='models.switch' AND actor=${actor}`)[0]!.n, initial!.n);
});

test("real admin HTTP contracts preserve authorization, CSRF, configuration precedence and read-only behavior", async (t) => {
  const app = await buildApp();
  const baseline = await paidCounts();
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => { fetches++; throw new Error("admin HTTP queries must not call a provider"); });
  try {
    const anonymous = await app.inject({ method: "GET", url: "/api/admin/models" });
    assert.equal(anonymous.statusCode, 401);
    config.devAdmin = { displayName: actor };
    const response = await app.inject({ method: "GET", url: "/api/admin/models?days=30" });
    assert.equal(response.statusCode, 200); assert.match(response.headers["cache-control"]!, /no-store/);
    const overview = response.json<AdminModels>();
    assert.equal(overview.days, 30); assert.equal(overview.capabilities.length, 11);
    assert.equal(overview.choices.find((c) => c.key === "default")!.model, "Ling-3.1-flash");
    assert.equal(overview.choices.find((c) => c.key === "ling-3.1-flash")!.provider, "ant-ling");
    const url = "/api/admin/models/score";
    const payload = { model: "ling-3.1-flash", reason: "test HTTP model routing" };
    assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 403);
    const changed = await app.inject({ method: "POST", url, payload, headers: { "x-csrf-token": "dev" } });
    assert.equal(changed.statusCode, 200); assert.equal(changed.json().after.model, "ling-3.1-flash");
    process.env.SCORE_MODEL = "glm-5.3-flash";
    const restored = await app.inject({ method: "POST", url, payload: { model: null, reason: "restore env via HTTP" }, headers: { "x-csrf-token": "dev" } });
    assert.equal(restored.statusCode, 200); assert.deepEqual(restored.json().after, { model: "glm-5.3-flash", source: "env" });
    const reread = (await app.inject({ method: "GET", url: "/api/admin/models" })).json<AdminModels>();
    assert.deepEqual(reread.capabilities.find((c) => c.key === "score")!.current, { model: "glm-5.3-flash", source: "env" });
    assert.equal(fetches, 0); assert.deepEqual(await paidCounts(), baseline);
  } finally { await app.close(); }
});
