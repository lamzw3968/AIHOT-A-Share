import { listenForFetch } from "./http-fixture.ts";
// Evaluate the real CLI/receipts against loopback stubs, never a paid provider.
import { gate, Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect, promisify } from "node:util";
import { after, test } from "node:test";
import { withIsolatedBudget as withBudget } from "./budget-fixture.ts";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { providerQuotaKey } from "@aihot/backend/providers/provider-quotas";
import { importSelectBenchRun } from "@aihot/backend/admin/selectbench";

const exec = promisify(execFile);
const outputRoots: string[] = [];
const quality = ["accuracy", "precision", "recall", "f1", "selectedRate", "goldSelectRate"];
const pass = { choices: [{ message: { content: '{"label":"PASS","reason":"fictional finance"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
const scored = { choices: [{ message: { content: '{"attentionScore":80}' } }], usage: { prompt_tokens: 20, completion_tokens: 10 } };
const limited = new Reply(429, { error: { type: "rate_limit", message: "isolated fake provider limit" } });

interface Report {
  meta: { incomplete?: boolean; pause?: { kind: string; retryAt: string | null }; requestedModels?: string[]; completedModels?: string[]; unstartedModels?: string[] };
  models: Record<string, { summary: Record<string, unknown>; sweep: unknown[]; cases: Array<{ caseId: string; incomplete?: boolean; unstarted?: boolean; decision: string | null; error: string | null }> }>;
}

async function evaluate(opts: { prefilter: string; score: string; models?: string; concurrency?: string; count?: number; env?: NodeJS.ProcessEnv }) {
  const marker = tag();
  const dir = mkdtempSync(path.join(tmpdir(), "selection-eval-protection-"));
  outputRoots.push(dir);
  const gold = path.join(dir, "gold.jsonl");
  writeFileSync(gold, Array.from({ length: opts.count ?? 4 }, (_, i) => JSON.stringify({
    caseId: `${marker}-${i}`,
    material: { title: `Fictional contract ${marker}-${i}`, originalTitle: null, publishedAt: "2026-10-01T09:00:00+08:00",
      sourceName: "Fictional finance source", bodyZh: null, bodyOriginal: `Fictional company ${marker}-${i} disclosed an order with amount and execution dates. `.repeat(8) },
    sourceFacts: { sourceKind: "rss", sourceTier: "T1", firstParty: true, language: "en" }, gold: { decision: "select" },
  })).join("\n"));
  const env: NodeJS.ProcessEnv = { ...process.env, AIHOT_DATA_DIR: path.join(dir, "data"), MODEL_CALLS_ENABLED: "true", PREFILTER_MODEL: "qwen3.7-flash",
    DASHSCOPE_BASE_URL: `${opts.prefilter}/v1`, DASHSCOPE_API_KEY: "dummy-eval-prefilter",
    ZHIPU_BASE_URL: `${opts.score}/v1`, ZHIPU_API_KEY: "dummy-eval-score",
    DEEPSEEK_BASE_URL: `${opts.score}/v1`, DEEPSEEK_API_KEY: "dummy-eval-deepseek",
    ANT_LING_BASE_URL: `${opts.score}/v1`, ANT_LING_API_KEY: `dummy-eval-ling-${marker}`, ANT_LING_QPS: "1000" };
  delete env.ANT_LING_QUOTA_GROUP; delete env.ANT_LING_EXTRA_JSON;
  Object.assign(env, opts.env);
  let stdout = "", stderr = "", code = 0;
  try {
    const result = await exec(process.execPath, ["scripts/eval-selection.ts", "--gold", gold, "--concurrency", opts.concurrency ?? "1",
      "--models", opts.models ?? "glm-5.3-flash-selection,deepseek-flash"], { cwd: REPO_ROOT, env, timeout: 25_000 });
    stdout = result.stdout; stderr = result.stderr;
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string; signal?: string | null; killed?: boolean };
    if (typeof result.code !== "number" || result.code > 255 || result.signal || result.killed) {
      // Native crashes/timeouts may have empty stdout/stderr. Retain the original exec error and
      // complete cause before the normal exit-code assertions fail; never retry a possibly paid CLI.
      console.error("evaluation child abnormal exit", inspect({ node: process.version, executable: process.execPath,
        exitCode: result.code, signal: result.signal, killed: result.killed, error },
      { depth: null, showHidden: true, maxArrayLength: null, maxStringLength: null, colors: false }));
    }
    assert.equal(typeof result.code, "number", "CLI must finish normally, not be killed by its test timeout");
    code = result.code; stdout = result.stdout; stderr = result.stderr;
  }
  const reportPath = stdout.split(/\r?\n/).find((line) => line.startsWith("report: "))?.slice(8);
  let report: Report | null = null;
  if (reportPath) {
    assert.equal(path.dirname(reportPath), path.resolve(env.AIHOT_DATA_DIR!, "eval"));
    report = JSON.parse(readFileSync(reportPath, "utf8"));
    unlinkSync(reportPath);
  }
  return { marker, code, stdout, stderr, report };
}

async function importCounts() {
  const [row] = await sql`SELECT (SELECT count(*)::int FROM selectbench_runs) AS runs,
    (SELECT count(*)::int FROM selectbench_results) AS results,
    (SELECT count(*)::int FROM audit_log WHERE action='selectbench.import') AS audit`;
  return row!;
}

async function withRoutes<T>(fn: () => Promise<T>, imported = { runs: 0, results: 0, audit: 0 }) {
  const saved = await sql<{ key: string; value: unknown; updated_by: string | null; updated_at: Date }[]>`
    SELECT key,value,updated_by,updated_at FROM settings WHERE key IN ('models.prefilter','models.score')`;
  const before = await importCounts();
  await sql`DELETE FROM settings WHERE key IN ('models.prefilter','models.score')`;
  try {
    const result = await fn();
    assert.deepEqual(await importCounts(), { runs: before.runs + imported.runs, results: before.results + imported.results, audit: before.audit + imported.audit },
      "only complete CLI runs may write their expected SelectBench run, cases and audit entry");
    return result;
  } finally {
    await sql`DELETE FROM settings WHERE key IN ('models.prefilter','models.score')`;
    for (const row of saved) await sql`INSERT INTO settings (key,value,updated_by,updated_at)
      VALUES (${row.key},${sql.json(row.value as never)},${row.updated_by},${row.updated_at})`;
  }
}

async function assertIncomplete(result: Awaited<ReturnType<typeof evaluate>>, kind: string) {
  assert.equal(result.code, 2, `${result.stdout}\n${result.stderr}`);
  assert.ok(result.report, "interruption still writes a diagnostic report");
  assert.equal(result.report.meta.incomplete, true);
  assert.equal(result.report.meta.pause!.kind, kind);
  assert.match(result.stderr, /incomplete/i);
  for (const model of Object.values(result.report.models)) {
    assert.equal(model.summary.incomplete, true);
    for (const key of quality) assert.equal(model.summary[key], null, `partial ${key} must not rank a model`);
    assert.deepEqual(model.sweep, [], "partial data has no threshold quality sweep");
  }
  const [pending] = await sql`SELECT count(*)::int AS n FROM receipts WHERE status='pending' AND subject LIKE ${`article:gold-${result.marker}%`}`;
  assert.equal(pending!.n, 0, "every request already sent settles before report generation and pool closure");
  await assert.rejects(importSelectBenchRun(result.report, "manual attempt to import actual interrupted output", "eval-protection-test"),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 400);
  return result.report;
}

after(closeDb);
after(() => { for (const dir of outputRoots) rmSync(dir, { recursive: true, force: true }); });

test("429 stops new cases and later models while an already-started double score safely drains", async (t) => withRoutes(async () => {
  const release = gate();
  const prefilter = await stub(() => pass);
  const score = await stub(async (hit) => {
    if (hit === 1) await release.promise;
    if (hit === 2) { setTimeout(() => release.open(), 150); return limited; }
    return scored;
  });
  t.after(async () => { release.open(); await Promise.all([prefilter.close(), score.close()]); });
  const result = await evaluate({ prefilter: prefilter.url, score: score.url, concurrency: "2" });
  const report = await assertIncomplete(result, "provider-429");
  assert.deepEqual(Object.keys(report.models), ["glm-5.3-flash-selection"]);
  const summary = report.models["glm-5.3-flash-selection"]!.summary;
  assert.equal(summary.errors, 0); assert.equal(summary.deferred, 1); assert.equal(summary.unstarted, 2);
  assert.equal(prefilter.hits(), 2); assert.equal(score.hits(), 3, "one rejected request and the other case's two scores, without a retry");
  assert.deepEqual(report.meta.unstartedModels, ["deepseek-flash"]);
}));

test("a prefilter 429 also stops a delayed in-flight prefilter from starting new scoring", async (t) => withRoutes(async () => {
  const prefilter = await stub(async (hit) => {
    if (hit === 1) return limited;
    await new Promise((resolve) => setTimeout(resolve, 150));
    return pass;
  });
  const score = await stub(() => scored);
  t.after(async () => { await Promise.all([prefilter.close(), score.close()]); });
  const result = await evaluate({ prefilter: prefilter.url, score: score.url, concurrency: "2" });
  const report = await assertIncomplete(result, "provider-429");
  assert.equal(prefilter.hits(), 2); assert.equal(score.hits(), 0);
  assert.equal(report.models["glm-5.3-flash-selection"]!.summary.unstarted, 2);
}));

test("a second-score 429 preserves the successful first score and does not start another sample", async (t) => withRoutes(async () => {
  const prefilter = await stub(() => pass);
  const score = await stub((hit) => hit === 2 ? limited : scored);
  t.after(async () => { await Promise.all([prefilter.close(), score.close()]); });
  const result = await evaluate({ prefilter: prefilter.url, score: score.url });
  const report = await assertIncomplete(result, "provider-429");
  assert.equal(prefilter.hits(), 1); assert.equal(score.hits(), 2);
  assert.equal(report.models["glm-5.3-flash-selection"]!.summary.deferred, 1);
  const rows = await sql`SELECT a.status FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id
    WHERE r.subject LIKE ${`article:gold-${result.marker}%`} AND r.purpose='score_article' ORDER BY a.id`;
  assert.deepEqual(rows.map((row) => row.status), ["received", "failed"]);
}));

test("real Ling admission waiting creates no score attempt, quality ranking or automatic SelectBench import", async (t) => withRoutes(async () => {
  const prefilter = await stub(() => pass);
  const score = await stub(() => scored);
  t.after(async () => { await Promise.all([prefilter.close(), score.close()]); });
  const key = `dummy-eval-quota-${tag()}`;
  const quota = providerQuotaKey("ant-ling", `${score.url}/v1/chat/completions`, key);
  await sql`INSERT INTO provider_quotas (quota_key,cooldown_until) VALUES (${quota},now()+interval '60 seconds')`;
  const result = await evaluate({ prefilter: prefilter.url, score: score.url, models: "ling-3.1-flash,deepseek-flash", env: { ANT_LING_API_KEY: key } });
  const report = await assertIncomplete(result, "provider-admission");
  assert.equal(prefilter.hits(), 1); assert.equal(score.hits(), 0);
  assert.equal(report.models["ling-3.1-flash"]!.summary.errors, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE purpose='score_article' AND subject LIKE ${`article:gold-${result.marker}%`}`)[0]!.n, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM provider_quota_leases WHERE quota_key=${quota}`)[0]!.n, 0);
}));

test("exhausted prefilter and scoring budgets stop evaluation without being counted as quality errors", async (t) => withRoutes(async () => {
  const prefilter = await stub(() => pass);
  const score = await stub(() => scored);
  t.after(async () => { await Promise.all([prefilter.close(), score.close()]); });
  await withBudget("dashscope", 0, async () => {
    const result = await evaluate({ prefilter: prefilter.url, score: score.url });
    const report = await assertIncomplete(result, "budget");
    assert.equal(prefilter.hits(), 0); assert.equal(score.hits(), 0);
    assert.equal(report.models["glm-5.3-flash-selection"]!.summary.errors, 0);
  });
  await withBudget("zhipu", 0, async () => {
    const result = await evaluate({ prefilter: prefilter.url, score: score.url });
    const report = await assertIncomplete(result, "budget");
    assert.equal(prefilter.hits(), 1); assert.equal(score.hits(), 0);
    assert.ok(new Date(report.meta.pause!.retryAt!).getTime() > Date.now());
  });
}));

test("budget exhaustion between the two scores preserves the first paid response without sending score two", async (t) => withRoutes(async () => {
  const prefilter = await stub(() => pass);
  const score = await stub(() => scored);
  t.after(async () => { await Promise.all([prefilter.close(), score.close()]); });
  await withBudget("zhipu", 1, async () => {
    const result = await evaluate({ prefilter: prefilter.url, score: score.url });
    await assertIncomplete(result, "budget");
    assert.equal(prefilter.hits(), 1); assert.equal(score.hits(), 1);
    const rows = await sql`SELECT a.status FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id
      WHERE r.subject LIKE ${`article:gold-${result.marker}%`} AND r.purpose='score_article'`;
    assert.deepEqual(rows.map((row) => row.status), ["received"]);
  });
}));

test("an interruption in a later model invalidates quality fields for the entire comparison", async (t) => withRoutes(async () => {
  const prefilter = await stub(() => pass);
  const score = await stub((_hit, req) => JSON.parse(req.body).model === "deepseek-flash" ? limited : scored);
  t.after(async () => { await Promise.all([prefilter.close(), score.close()]); });
  const result = await evaluate({ prefilter: prefilter.url, score: score.url, count: 1,
    models: "glm-5.3-flash-selection,deepseek-flash,ling-3.1-flash" });
  const report = await assertIncomplete(result, "provider-429");
  assert.deepEqual(Object.keys(report.models), ["glm-5.3-flash-selection", "deepseek-flash"]);
  assert.equal(prefilter.hits(), 1, "the next model reuses the original prefilter receipt");
  assert.equal(score.hits(), 3);
  assert.deepEqual(report.meta.completedModels, ["glm-5.3-flash-selection"]);
  assert.deepEqual(report.meta.unstartedModels, ["ling-3.1-flash"]);
}));

test("a connection lost after sending remains unknown and stops evaluation without a hidden repeat", async (t) => withRoutes(async () => {
  let hits = 0;
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => { hits++; res.destroy(); });
  });
  await listenForFetch(provider);
  const endpoint = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const score = await stub(() => scored);
  t.after(async () => { await score.close(); await new Promise<void>((resolve) => provider.close(() => resolve())); });
  const result = await evaluate({ prefilter: endpoint, score: score.url });
  await assertIncomplete(result, "receipt-unknown");
  assert.equal(hits, 1); assert.equal(score.hits(), 0);
  const rows = await sql`SELECT r.status,a.status AS attempt FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id
    WHERE r.subject LIKE ${`article:gold-${result.marker}%`}`;
  assert.deepEqual(rows.map((row) => ({ ...row })), [{ status: "unknown", attempt: "unknown" }]);
}));

test("a complete live-path Mock comparison still imports automatically with valid historical metrics", async (t) => withRoutes(async () => {
  const prefilter = await stub(() => pass);
  const score = await stub(() => scored);
  t.after(async () => { await Promise.all([prefilter.close(), score.close()]); });
  const result = await evaluate({ prefilter: prefilter.url, score: score.url, count: 2 });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(result.report); assert.notEqual(result.report.meta.incomplete, true);
  for (const model of Object.values(result.report.models)) {
    assert.equal(model.summary.errors, 0); assert.equal(model.summary.accuracy, 1); assert.equal(model.summary.f1, 1);
    assert.ok(model.sweep.length > 0); assert.equal(model.cases.length, 2);
  }
  assert.match(result.stdout, /SelectBench run: sb-/);
  assert.equal(prefilter.hits(), 2); assert.equal(score.hits(), 8);
}, { runs: 1, results: 4, audit: 1 }));

test("invalid concurrency, duplicate model lists and empty samples fail before sending or creating a quality report", async (t) => withRoutes(async () => {
  const prefilter = await stub(() => pass);
  const score = await stub(() => scored);
  t.after(async () => { await Promise.all([prefilter.close(), score.close()]); });
  for (const concurrency of ["0", "-1", "NaN", "1.5"]) {
    const result = await evaluate({ prefilter: prefilter.url, score: score.url, concurrency });
    assert.equal(result.code, 1); assert.equal(result.report, null);
  }
  const duplicate = await evaluate({ prefilter: prefilter.url, score: score.url, models: "deepseek-flash,deepseek-flash" });
  assert.equal(duplicate.code, 1); assert.equal(duplicate.report, null);
  const empty = await evaluate({ prefilter: prefilter.url, score: score.url, count: 0 });
  assert.equal(empty.code, 1); assert.equal(empty.report, null);
  assert.equal(prefilter.hits(), 0); assert.equal(score.hits(), 0);
}));
