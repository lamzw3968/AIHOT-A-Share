import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { importSelectBenchRun, selectBenchRun } from "@aihot/backend/admin/selectbench";
import { buildApp } from "../apps/api/src/app.ts";

const actor = `selectbench-import-${tag()}`;
const savedConfig = { devAdmin: config.devAdmin, environmentName: config.environmentName, modelCallsEnabled: config.modelCallsEnabled };
after(async () => { Object.assign(config, savedConfig); await closeDb(); });

function complete() {
  const model = (name: string) => ({
    summary: { model: name, n: 2, decisive: 2, either: 0, errors: 0, tp: 1, fp: 0, fn: 0, tn: 1,
      accuracy: 1, precision: 1, recall: 1, f1: 1, selectedRate: 0.5, goldSelectRate: 0.5 },
    sweep: [{ t: 60, acc: 1, P: 1, R: 1, F1: 1, sel: 0.5 }],
    cases: [
      { caseId: "contract", title: "虚构公司披露重大合同", gold: "select", decision: "select" as string | null, score: 80, error: null as string | null },
      { caseId: "promotion", title: "虚构财经培训广告", gold: "reject", decision: "reject" as string | null, score: 10, error: null as string | null },
    ],
  });
  return { meta: { n: 2, split: "development", seed: 7, promptVersion: "fake-selection-version", incomplete: false,
    requestedModels: ["glm", "ling"], completedModels: ["glm", "ling"], unstartedModels: [] as string[] },
  models: { glm: model("glm"), ling: model("ling") } };
}

async function counts() {
  const [row] = await sql`SELECT (SELECT count(*)::int FROM selectbench_runs) AS runs,
    (SELECT count(*)::int FROM selectbench_results) AS results,
    (SELECT count(*)::int FROM audit_log) AS audit,
    (SELECT count(*)::int FROM receipts) AS receipts,
    (SELECT count(*)::int FROM receipt_attempts) AS attempts`;
  return row!;
}

async function rejectsUnchanged(report: unknown) {
  const before = await counts();
  await assert.rejects(importSelectBenchRun(report, "rejected fake report", actor), (error: unknown) => {
    assert.equal((error as { statusCode?: number }).statusCode, 400);
    assert.match((error as Error).message, /incomplete or invalid/);
    return true;
  });
  assert.deepEqual(await counts(), before, "rejection must precede run, case, audit and paid-service writes");
}

test("SelectBench rejects interruption markers at every level even when meta claims complete", async () => {
  for (const level of ["report", "meta", "model", "summary", "case"]) {
    for (const marker of [{ incomplete: true }, { deferred: 1 }, { unstarted: true }, { pause: { kind: "provider-429" } }, { pause: { kind: "budget" } }]) {
      const report = complete();
      const target = level === "report" ? report : level === "meta" ? report.meta : level === "model" ? report.models.ling
        : level === "summary" ? report.models.ling.summary : report.models.ling.cases[1]!;
      Object.assign(target, marker);
      await rejectsUnchanged(report);
    }
  }
});

test("SelectBench rejects omitted models or summaries instead of silently ranking the remaining model", async () => {
  const missing = complete();
  delete (missing.models as Partial<typeof missing.models>).ling;
  await rejectsUnchanged(missing);
  for (const broken of [null, {}, { cases: [] }, { summary: null }]) {
    const report = complete();
    (report.models as Record<string, unknown>).ling = broken;
    await rejectsUnchanged(report);
  }
  for (const change of [
    { requestedModels: ["glm", "ling", "unstarted-model"] },
    { completedModels: ["glm"] },
    { unstartedModels: ["ling"] },
    { requestedModels: ["glm", "glm"] },
  ]) {
    const report = complete();
    Object.assign(report.meta, change);
    await rejectsUnchanged(report);
  }
});

test("SelectBench rejects empty, partial, duplicate and different per-model case coverage", async () => {
  for (const cases of [[], complete().models.ling.cases.slice(0, 1), [complete().models.ling.cases[0]!, complete().models.ling.cases[0]!]]) {
    const report = complete();
    report.models.ling.cases = cases;
    await rejectsUnchanged(report);
  }
  const different = complete();
  different.models.ling.cases[1]!.caseId = "different-case";
  await rejectsUnchanged(different);
  const abandoned = complete();
  abandoned.models.ling.cases[1]!.decision = null;
  await rejectsUnchanged(abandoned);
});

test("SelectBench rejects conflicting sample sizes, incomplete totals and invalid quality metrics", async () => {
  for (const report of [null, [], {}, { models: {} }, { meta: [], models: complete().models }]) await rejectsUnchanged(report);
  for (const change of [{ n: 1 }, { n: 0 }, { n: 2.5 }, { n: "2" }, { errors: 1 }, { decisive: 1 }]) {
    const report = complete();
    Object.assign(report.models.ling.summary, change);
    await rejectsUnchanged(report);
  }
  for (const field of ["accuracy", "precision", "recall", "f1", "selectedRate", "goldSelectRate"]) {
    for (const value of [null, NaN, Infinity, -0.1, 1.1, "1"]) {
      const report = complete();
      Object.assign(report.models.ling.summary, { [field]: value });
      await rejectsUnchanged(report);
    }
  }
  const noCasesButPartial = { glm: { summary: { n: 2, decisive: 1, either: 0, errors: 0, accuracy: 1 } } };
  await rejectsUnchanged(noCasesButPartial);
});

test("SelectBench imports complete reports with every model and preserves per-case quality and audit", async () => {
  const report = complete();
  const before = await counts();
  const result = await importSelectBenchRun(report, "complete fake comparison", actor);
  const after = await counts();
  assert.deepEqual(after, { ...before, runs: before.runs + 1, results: before.results + 4, audit: before.audit + 1 });
  const stored = await selectBenchRun(result.id, {});
  assert.ok(stored);
  assert.equal(stored.run.sample_size, 2);
  assert.deepEqual(stored.run.models, ["glm", "ling"]);
  assert.equal(stored.run.prompt_version, "fake-selection-version");
  assert.equal(stored.rows.length, 2);
  assert.deepEqual(Object.keys(stored.rows[0]!.by_model).sort(), ["glm", "ling"]);
  const [audit] = await sql`SELECT action,actor,after FROM audit_log WHERE subject=${`selectbench:${result.id}`}`;
  assert.equal(audit!.action, "selectbench.import"); assert.equal(audit!.actor, actor);
  assert.deepEqual(audit!.after, { label: "complete fake comparison", models: ["glm", "ling"], sampleSize: 2 });
});

test("SelectBench preserves both historical report shapes, including optional case details", async () => {
  const full = complete();
  const legacy = { glm: full.models.glm, ling: full.models.ling };
  const { id } = await importSelectBenchRun(legacy, "legacy keyed report", actor);
  assert.equal((await selectBenchRun(id, {}))!.rows.length, 2);
  // Historical import explicitly supported absent cases. No absent evidence is invented as proof
  // of historical completeness; new explicit case lists and interruption metadata are checked above.
  for (const report of [
    { meta: { n: 2 }, models: { glm: { summary: full.models.glm.summary }, ling: { summary: full.models.ling.summary } } },
    { glm: { summary: full.models.glm.summary }, ling: { summary: full.models.ling.summary } },
  ]) {
    const result = await importSelectBenchRun(report, "legacy summary-only report", actor);
    const stored = await selectBenchRun(result.id, {});
    assert.equal(stored!.run.sample_size, 2); assert.deepEqual(stored!.run.models, ["glm", "ling"]);
    assert.equal(stored!.rows.length, 0);
  }
});

test("SelectBench accepts completed ordinary model-output errors rather than treating them as deferred samples", async () => {
  const model = complete().models.glm;
  model.cases[1]!.decision = null;
  model.cases[1]!.error = "ModelOutputError: response was not valid JSON after the completed attempts";
  Object.assign(model.summary, { decisive: 1, errors: 1, tp: 1, tn: 0, selectedRate: 1, goldSelectRate: 1 });
  const result = await importSelectBenchRun({ meta: { n: 2 }, models: { glm: model } }, "ordinary fake output error", actor);
  const stored = await selectBenchRun(result.id, { outcome: "error" });
  assert.equal(stored!.rows.length, 1);
  assert.equal(stored!.rows[0]!.case_id, "promotion");
  assert.equal(stored!.rows[0]!.by_model.glm!.decision, null);
  assert.match(stored!.rows[0]!.by_model.glm!.error!, /ModelOutputError/);
});

test("manual SelectBench HTTP import keeps authentication and CSRF and returns 400 without writes for incomplete reports", async (t) => {
  config.devAdmin = null; config.environmentName = "test"; config.modelCallsEnabled = false;
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => { fetches++; throw new Error("SelectBench import must not call a provider"); });
  const app = await buildApp();
  try {
    const url = "/api/admin/selectbench/import";
    const before = await counts();
    const payload = { report: complete(), label: "manual fake comparison" };
    assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 401);
    config.devAdmin = { displayName: actor };
    assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 403);
    assert.deepEqual(await counts(), before);
    for (const level of ["meta", "summary", "case", "missing-model"]) {
      const report = complete();
      if (level === "meta") Object.assign(report.meta, { incomplete: true, pause: { kind: "provider-admission" } });
      else if (level === "summary") Object.assign(report.models.ling.summary, { deferred: 1, accuracy: null });
      else if (level === "case") Object.assign(report.models.ling.cases[1]!, { unstarted: true });
      else delete (report.models as Partial<typeof report.models>).ling;
      const denied = await app.inject({ method: "POST", url, payload: { report }, headers: { "x-csrf-token": "dev" } });
      assert.equal(denied.statusCode, 400); assert.match(denied.body, /incomplete or invalid/);
      assert.deepEqual(await counts(), before);
    }
    const accepted = await app.inject({ method: "POST", url, payload, headers: { "x-csrf-token": "dev" } });
    assert.equal(accepted.statusCode, 200);
    const stored = await selectBenchRun(accepted.json<{ id: string }>().id, {});
    assert.equal(stored!.run.label, "manual fake comparison"); assert.equal(stored!.rows.length, 2);
    assert.equal(fetches, 0);
    const end = await counts();
    assert.deepEqual(end, { ...before, runs: before.runs + 1, results: before.results + 4, audit: before.audit + 1 });
  } finally { await app.close(); Object.assign(config, savedConfig); }
});
