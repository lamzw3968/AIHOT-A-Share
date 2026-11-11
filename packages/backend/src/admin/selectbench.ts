// SelectBench (docs/01 F20): selection-model comparison runs on the human gold set. Runs come from
// scripts/eval-selection.ts (imported automatically) or an uploaded report; the admin compares
// models on the same cases and browses each case.
import type { AdminSelectBenchCases, AdminSelectBenchRuns, BeforeJson } from "@aihot/contracts/admin";
import { randomBytes } from "node:crypto";
import { sql } from "../db.ts";
import { audit } from "../audit.ts";

interface CaseIn {
  caseId: string;
  title: string;
  stratum?: string | null;
  gold: string;
  decision: string | null;
  score?: number | null;
  relevance?: string | null;
  category?: string | null;
  reason?: string | null;
  receiptId?: number | null;
  error?: string | null;
}

interface ModelReport {
  summary: Record<string, unknown>;
  sweep?: unknown[];
  cases?: CaseIn[];
}

function invalidReport(detail: string): never {
  throw Object.assign(new Error(`SelectBench report is incomplete or invalid: ${detail}`), { statusCode: 400 });
}
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalidReport(`${field} must be a non-negative integer`);
  return value as number;
};

function rejectInterruption(value: Record<string, unknown>) {
  for (const field of ["incomplete", "deferred", "unstarted"]) {
    if (value[field] !== undefined && value[field] !== null && value[field] !== false && value[field] !== 0) invalidReport(`contains ${field}`);
  }
  if (value.pause !== undefined && value.pause !== null) invalidReport("contains a pause");
}

/** Validate before any DB/audit write. Absent cases remain supported for historical summary-only
 * reports; an explicitly supplied case list must cover the whole sample for every model. */
function completeReport(report: unknown) {
  if (!isRecord(report)) invalidReport("expected an object");
  const r = report as Record<string, unknown>;
  rejectInterruption(r);
  if (r.meta !== undefined && !isRecord(r.meta)) invalidReport("invalid metadata");
  const meta = (r.meta ?? {}) as Record<string, unknown>;
  rejectInterruption(meta);
  const rawModels = r.models ?? Object.fromEntries(Object.entries(r).filter(([key]) => key !== "meta"));
  if (!isRecord(rawModels) || !Object.keys(rawModels).length) invalidReport("no model summaries");
  const models = rawModels as Record<string, ModelReport>;
  const names = Object.keys(models);
  for (const field of ["requestedModels", "completedModels", "unstartedModels"]) {
    const value = meta[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !name.trim()) || new Set(value).size !== value.length) invalidReport(`invalid ${field}`);
    const expected = field === "unstartedModels" ? [] : names;
    if (JSON.stringify([...value].sort()) !== JSON.stringify([...expected].sort())) invalidReport(`${field} does not match model coverage`);
  }
  let sampleSize: number | undefined = meta.n === undefined ? undefined : count(meta.n, "meta.n");
  let caseIds: string[] | undefined;
  for (const name of names) {
    const model = models[name];
    if (!name.trim() || !isRecord(model) || !isRecord(model.summary)) invalidReport("missing model summary");
    const summary = model!.summary;
    rejectInterruption(model as unknown as Record<string, unknown>);
    rejectInterruption(summary);
    for (const field of ["accuracy", "precision", "recall", "f1", "selectedRate", "goldSelectRate"]) {
      if (summary[field] !== undefined && (typeof summary[field] !== "number" || !Number.isFinite(summary[field]) || (summary[field] as number) < 0 || (summary[field] as number) > 1)) invalidReport(`invalid ${field}`);
    }
    const n = summary.n === undefined ? sampleSize : count(summary.n, "summary.n");
    if (n === undefined || n === 0 || (sampleSize !== undefined && sampleSize !== n)) invalidReport("model sample sizes do not match");
    sampleSize = n;
    for (const field of ["decisive", "either", "errors"]) if (summary[field] !== undefined) count(summary[field], field);
    if (["decisive", "either", "errors"].every((field) => summary[field] !== undefined)
      && Number(summary.decisive) + Number(summary.either) + Number(summary.errors) !== n) invalidReport("summary does not cover the sample");
    if (model!.cases !== undefined) {
      if (!Array.isArray(model!.cases) || model!.cases.length !== n) invalidReport("case list does not cover the sample");
      let errors = 0, either = 0;
      const ids: string[] = [];
      for (const item of model!.cases) {
        if (!isRecord(item)) invalidReport("invalid case");
        rejectInterruption(item as unknown as Record<string, unknown>);
        if (typeof item.caseId !== "string" || !item.caseId.trim() || typeof item.title !== "string"
          || !["select", "reject", "either"].includes(item.gold)) invalidReport("invalid case identity or gold label");
        ids.push(item.caseId);
        if (item.decision === null) {
          // A completed attempt with a bad output is still a historical quality error, not a pause.
          if (typeof item.error !== "string" || !item.error.trim()) invalidReport("case has no completed decision or error");
          errors++;
        } else if (!["select", "reject"].includes(item.decision)) invalidReport("invalid case decision");
        else if (item.gold === "either") either++;
      }
      ids.sort();
      if (new Set(ids).size !== ids.length || (caseIds && JSON.stringify(caseIds) !== JSON.stringify(ids))) invalidReport("case coverage differs across models");
      caseIds = ids;
      for (const [field, actual] of [["errors", errors], ["either", either], ["decisive", n - errors - either]] as const) {
        if (summary[field] !== undefined && summary[field] !== actual) invalidReport(`${field} does not match completed cases`);
      }
    }
  }
  return { meta, models, names, sampleSize: sampleSize! };
}

/** Accepts { meta, models } or the older report shape keyed by model name. */
export async function importSelectBenchRun(report: unknown, label: string, actor: string) {
  const { meta, models, names, sampleSize } = completeReport(report);
  const id = `sb-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(3).toString("hex")}`;
  const summary = Object.fromEntries(names.map((m) => [m, { ...models[m]!.summary, sweep: models[m]!.sweep ?? [] }]));
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO selectbench_runs (id, label, split, sample_size, seed, prompt_version, models, summary, imported_by)
      VALUES (${id}, ${label}, ${(meta.split as string) ?? null}, ${sampleSize}, ${(meta.seed as number) ?? null}, ${(meta.promptVersion as string) ?? null}, ${names}, ${tx.json(summary as never)}, ${actor})`;
    for (const m of names) {
      const cases = models[m]!.cases ?? [];
      for (let i = 0; i < cases.length; i += 500) {
        const rows = cases.slice(i, i + 500).map((c) => ({
          run_id: id,
          model: m,
          case_id: c.caseId,
          title: c.title,
          stratum: c.stratum ?? null,
          gold: c.gold,
          decision: c.decision,
          score: c.score ?? null,
          relevance: c.relevance ?? null,
          category: c.category ?? null,
          reason: c.reason ?? null,
          receipt_id: c.receiptId ?? null,
          error: c.error ?? null,
        }));
        await tx`INSERT INTO selectbench_results ${tx(rows)} ON CONFLICT DO NOTHING`;
      }
    }
  });
  await audit(actor, "selectbench.import", `selectbench:${id}`, null, null, { label, models: names, sampleSize });
  return { id };
}

export async function listSelectBenchRuns(): Promise<BeforeJson<AdminSelectBenchRuns["runs"]>> {
  return sql<BeforeJson<AdminSelectBenchRuns["runs"][number]>[]>`
    SELECT r.id, r.label, r.split, r.sample_size, r.prompt_version, r.models,
           (SELECT coalesce(jsonb_object_agg(key, value - 'sweep'), '{}'::jsonb) FROM jsonb_each(r.summary)) AS summary,
           r.created_at, r.imported_by,
           (SELECT count(*)::int FROM selectbench_results x WHERE x.run_id = r.id) AS cases
    FROM selectbench_runs r ORDER BY r.created_at DESC LIMIT 100`;
}

export async function selectBenchRun(id: string, f: { model?: string; outcome?: string; stratum?: string; disagree?: boolean }): Promise<BeforeJson<AdminSelectBenchCases> | null> {
  const [run] = await sql<BeforeJson<AdminSelectBenchCases["run"]>[]>`SELECT * FROM selectbench_runs WHERE id = ${id}`;
  if (!run) return null;
  const outcome = f.outcome ?? null;
  // One row per case with every model's decision, so disagreements are visible side by side.
  const rows = await sql<AdminSelectBenchCases["rows"]>`
    SELECT case_id, min(title) AS title, min(stratum) AS stratum, min(gold) AS gold,
           jsonb_object_agg(model, jsonb_build_object('decision', decision, 'score', score, 'relevance', relevance, 'category', category, 'reason', reason, 'error', error, 'receiptId', receipt_id)) AS by_model
    FROM selectbench_results WHERE run_id = ${id} AND (${f.stratum ?? null}::text IS NULL OR stratum = ${f.stratum ?? null})
    GROUP BY case_id
    HAVING (${outcome}::text IS NULL OR bool_or(
      model = ${f.model ?? (run.models as string[])[0]!} AND CASE ${outcome}
        WHEN 'fp' THEN decision = 'select' AND gold = 'reject'
        WHEN 'fn' THEN decision = 'reject' AND gold = 'select'
        WHEN 'tp' THEN decision = 'select' AND gold = 'select'
        WHEN 'tn' THEN decision = 'reject' AND gold = 'reject'
        WHEN 'either' THEN gold = 'either'
        WHEN 'error' THEN decision IS NULL
        ELSE true END))
      AND (${!!f.disagree} IS FALSE OR count(DISTINCT decision) > 1)
    ORDER BY min(stratum), case_id LIMIT 400`;
  const strata = await sql<AdminSelectBenchCases["strata"]>`SELECT stratum, count(DISTINCT case_id)::int AS n FROM selectbench_results WHERE run_id = ${id} GROUP BY 1 ORDER BY 2 DESC`;
  return { run, rows, strata };
}
