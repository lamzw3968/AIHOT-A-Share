// Checks the selection against your own labelled samples (a "gold set"): each case runs the site's
// selection steps (editorial/analyze.ts) — the prefilter, then the score prompt twice with every model in
// --models, the two scores deciding against the source tier's threshold — and is compared with your
// decision. A threshold sweep shows what another threshold would have done. The format of the gold file
// is in docs/selection.md (industry/gold.example.jsonl has two made-up cases).
// Usage: node --env-file=.env scripts/eval-selection.ts --gold .data/gold.jsonl [--models default,deepseek-flash] [--n 200] [--label "..."]
// Receipts make re-runs free; "either" cases are excluded from decisive metrics. Each run is also
// imported into SelectBench (admin → SelectBench) with every case, unless --no-import is given.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import {
  SELECTION_PROMPT_VERSION,
  buildScoreInput,
  normalizeAnalysis,
  runSelectionPrefilter,
  runSelectionScores,
  tierThreshold,
  type AnalysisRun,
  type AnalyzeInputArticle,
} from "@aihot/backend/editorial/analyze";
import { modelFor } from "@aihot/backend/editorial/models";
import { importSelectBenchRun } from "@aihot/backend/admin/selectbench";
import { ProviderDeferredError } from "@aihot/backend/jobs/provider-deferred";
import { ModelOutputError } from "@aihot/backend/providers/llm";
import { BudgetExceededError, ProviderRejectedError, ReceiptBusyError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";

const { values } = parseArgs({
  options: {
    gold: { type: "string", default: ".data/gold.jsonl" },
    models: { type: "string" },
    n: { type: "string", default: "200" },
    split: { type: "string", default: "all" },
    concurrency: { type: "string", default: "6" },
    seed: { type: "string", default: "7" },
    label: { type: "string" },
    "no-import": { type: "boolean", default: false },
  },
});

function positiveInteger(value: string, option: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${option} must be a positive integer`);
  return n;
}
const concurrency = positiveInteger(values.concurrency!, "--concurrency");
const sampleLimit = positiveInteger(values.n!, "--n");

interface GoldRow {
  caseId: string;
  material: { title: string; originalTitle: string | null; publishedAt: string | null; sourceName: string; bodyZh: string | null; bodyOriginal: string | null };
  sourceFacts: { sourceKind: string; sourceTier?: string; firstParty?: boolean; language?: string | null };
  /** Optional: a split (e.g. development / holdout) and a stratum for reading the mistakes. */
  samplingContext?: { benchmarkSplit?: string; samplingStratum?: string };
  gold: { decision: "select" | "reject" | "either" };
}

const rows: GoldRow[] = readFileSync(path.resolve(REPO_ROOT, values.gold!), "utf8")
  .split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).map((l) => JSON.parse(l));

// Deterministic stratified sample.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const rand = rng(Number(values.seed));
const pool = values.split === "all" ? rows : rows.filter((r) => r.samplingContext?.benchmarkSplit === values.split);
const shuffled = pool.map((r) => ({ r, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.r);
const sample = shuffled.slice(0, sampleLimit);
if (!sample.length) throw new Error("the selected gold-set split has no cases to evaluate");

function toInput(r: GoldRow): AnalyzeInputArticle {
  const m = r.material;
  const isX = r.sourceFacts.sourceKind === "x_search";
  const body = m.bodyOriginal || m.bodyZh || null;
  return {
    id: `gold-${r.caseId}`,
    revision: 1,
    bodyStatus: "ok",
    title: m.originalTitle || m.title,
    url: "https://example.invalid/" + r.caseId,
    author: null,
    publishedAt: m.publishedAt ? new Date(m.publishedAt) : null,
    bodyText: isX ? null : body,
    excerpt: null,
    xPost: isX ? { authorName: m.sourceName, handle: "", text: body ?? m.title } : null,
    media: [],
    source: { name: m.sourceName, kind: r.sourceFacts.sourceKind, tier: r.sourceFacts.sourceTier ?? "T2", firstParty: r.sourceFacts.firstParty ?? false },
  };
}

async function pmap<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>, stopped: () => boolean): Promise<Array<R | undefined>> {
  const out: Array<R | undefined> = new Array(items.length);
  let i = 0;
  let failed = false;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length && !failed && !stopped()) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx]!);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }));
  // A worker failure must not close the DB while another worker still has a paid request in flight.
  const failure = workers.find((worker) => worker.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return out;
}

function safeReportNamePart(value: string): string {
  const safe = value.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return safe || "all";
}

async function usageFor(receiptIds: number[]) {
  const ids = [...new Set(receiptIds)];
  if (!ids.length) return { tokensIn: 0, tokensOut: 0, avgLatencyMs: 0 };
  const [usage] = await sql<{ tin: number; tout: number; latency: number }[]>`
    SELECT
      sum(coalesce((usage->>'prompt_tokens')::int, (usage->>'input_tokens')::int, 0)) AS tin,
      sum(coalesce((usage->>'completion_tokens')::int, (usage->>'output_tokens')::int, 0)) AS tout,
      avg(latency_ms) AS latency
    FROM receipt_attempts WHERE receipt_id IN ${sql(ids)}`;
  return {
    tokensIn: Number(usage?.tin ?? 0),
    tokensOut: Number(usage?.tout ?? 0),
    avgLatencyMs: Math.round(Number(usage?.latency ?? 0)),
  };
}

try {
  const models = values.models
    ? values.models.split(",").map((model) => model.trim()).filter(Boolean)
    : [await modelFor("score")];
  if (!models.length) throw new Error("--models did not name any models");
  if (new Set(models).size !== models.length) throw new Error("--models must not repeat a model");

  interface Pause {
    kind: "provider-admission" | "provider-429" | "budget" | "provider-error" | "receipt-busy" | "receipt-unknown" | "evaluation-error";
    message: string;
    retryAt: string | null;
  }
  interface EvaluationResult {
    r: GoldRow;
    out: ReturnType<typeof normalizeAnalysis> | null;
    receiptIds: number[];
    error: string | null;
    pause?: Pause;
    unstarted?: boolean;
  }
  interface ModelReport {
    summary: Record<string, unknown>;
    sweep: Array<Record<string, number>>;
    mistakes: Array<Record<string, unknown>>;
    cases: Array<Record<string, unknown>>;
  }
  const report: Record<string, ModelReport> = {};
  let stopped: Pause | null = null;
  function pauseFor(error: unknown): Pause | null {
    // A received but unusable answer remains a completed quality attempt. Operational interruptions
    // cannot produce rankable results; this evaluation-only classification never releases or retries
    // a busy/unknown receipt and does not change production queue behavior.
    if (error instanceof ModelOutputError) return null;
    const retrySeconds = error instanceof BudgetExceededError || error instanceof ProviderRejectedError ? error.retryAfterSeconds : undefined;
    const retryAt = retrySeconds === undefined ? null : new Date(Date.now() + retrySeconds * 1000);
    return stopped ??= {
      kind: error instanceof ProviderDeferredError ? "provider-admission"
        : error instanceof BudgetExceededError ? "budget"
        : error instanceof ReceiptBusyError ? "receipt-busy"
        : error instanceof ReceiptUnknownError ? "receipt-unknown"
        : error instanceof ProviderRejectedError ? error.status === 429 ? "provider-429" : "provider-error"
        : "evaluation-error",
      message: (error instanceof Error ? error.message : "Evaluation request failed")
        .replace(/(?:https?|postgres(?:ql)?):\/\/\S+/gi, "[endpoint]")
        .replace(/(api[-_ ]?key|authorization|password|token|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]")
        .replace(/\s+/g, " ").slice(0, 200),
      retryAt: error instanceof ProviderDeferredError ? error.retryAt.toISOString()
        : retryAt && Number.isFinite(retryAt.getTime()) ? retryAt.toISOString() : null,
    };
  }
  for (const model of models) {
    const started = Date.now();
    // Two gold cases can have different source metadata / thresholds while rendering the same score prompt.
    // Share only that score result (including a failure); prefilter and threshold semantics remain per case.
    const scoreRequests = new Map<string, Promise<{ scores: AnalysisRun["scores"]; receiptIds: number[]; error: string | null; pause?: Pause }>>();
    const partial = await pmap(sample, concurrency, async (r): Promise<EvaluationResult> => {
      const input = toInput(r);
      const receiptIds: number[] = [];
      try {
        const prefilter = await runSelectionPrefilter(input, {}, (id) => receiptIds.push(id));
        if (prefilter.label === "BLOCK") {
          const run: AnalysisRun = { prefilter, scores: null, writing: null, structure: null };
          return { r, out: normalizeAnalysis(run), receiptIds, error: null as string | null };
        }

        const threshold = tierThreshold(input.source.tier);
        if (threshold === null) {
          const run: AnalysisRun = { prefilter, scores: null, writing: null, structure: null };
          return { r, out: normalizeAnalysis(run), receiptIds, error: null as string | null };
        }

        const key = buildScoreInput(input);
        let request = scoreRequests.get(key);
        if (!request) {
          // Preserve completed prefilters after a peer pauses, without starting a new paid score chain.
          // Chains already started (including their second score) settle through the existing receipts.
          if (stopped) return { r, out: null, receiptIds, error: null, pause: stopped };
          const sharedReceiptIds: number[] = [];
          request = runSelectionScores(input, { scoreModel: model }, (id) => sharedReceiptIds.push(id)).then(
            (scores) => ({ scores, receiptIds: sharedReceiptIds, error: null }),
            (error: unknown) => {
              const pause = pauseFor(error);
              return { scores: null, receiptIds: sharedReceiptIds, error: pause ? null : String(error).slice(0, 200), ...(pause ? { pause } : {}) };
            },
          );
          scoreRequests.set(key, request);
        }
        const shared = await request;
        receiptIds.push(...shared.receiptIds);
        if (shared.pause) return { r, out: null, receiptIds, error: null, pause: shared.pause };
        if (shared.error) return { r, out: null, receiptIds, error: shared.error };

        // Model output is independent of source tier; the decision threshold is not.
        const scores = shared.scores ? { ...shared.scores, threshold } : null;
        const run: AnalysisRun = { prefilter, scores, writing: null, structure: null };
        return { r, out: normalizeAnalysis(run), receiptIds, error: null as string | null };
      } catch (error) {
        const pause = pauseFor(error);
        if (pause) return { r, out: null, receiptIds, error: null, pause };
        return { r, out: null, receiptIds, error: String(error).slice(0, 200) };
      }
    }, () => stopped !== null);
    // All started cases and their shared score chains have settled before reading usage or writing.
    const results: EvaluationResult[] = sample.map((r, i) => partial[i] ?? { r, out: null, receiptIds: [], error: null, unstarted: true });
    const incomplete = stopped !== null;
    const deferred = results.filter((x) => x.pause).length;
    const unstarted = results.filter((x) => x.unstarted).length;
    let tp = 0, fp = 0, fn = 0, tn = 0, either = 0, errors = 0;
    const mistakes: Array<Record<string, unknown>> = [];
    for (const x of results) {
      if (x.pause || x.unstarted) continue;
      if (!x.out) { errors++; continue; }
      const pred = x.out.selected ? "select" : "reject";
      const gold = x.r.gold.decision;
      if (gold === "either") { either++; continue; }
      if (pred === "select" && gold === "select") tp++;
      else if (pred === "select" && gold === "reject") { fp++; mistakes.push({ kind: "FP", title: x.r.material.title, score: x.out.score, reason: x.out.reasonZh, stratum: x.r.samplingContext?.samplingStratum ?? null }); }
      else if (pred === "reject" && gold === "select") { fn++; mistakes.push({ kind: "FN", title: x.r.material.title, score: x.out.score, relevance: x.out.relevance, stratum: x.r.samplingContext?.samplingStratum ?? null }); }
      else tn++;
    }
    const usage = await usageFor(results.flatMap((x) => x.receiptIds));
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);
    const f1 = (2 * precision * recall) / Math.max(1e-9, precision + recall);
    const summary = {
      model, n: sample.length, decisive: tp + fp + fn + tn, either, errors, tp, fp, fn, tn,
      ...(incomplete ? { incomplete, deferred, unstarted, pause: stopped } : {}),
      accuracy: incomplete ? null : +((tp + tn) / Math.max(1, tp + fp + fn + tn)).toFixed(3),
      precision: incomplete ? null : +precision.toFixed(3), recall: incomplete ? null : +recall.toFixed(3), f1: incomplete ? null : +f1.toFixed(3),
      selectedRate: incomplete ? null : +((tp + fp) / Math.max(1, tp + fp + fn + tn)).toFixed(3),
      goldSelectRate: incomplete ? null : +((tp + fn) / Math.max(1, tp + fp + fn + tn)).toFixed(3),
      ...usage,
      wallSeconds: Math.round((Date.now() - started) / 1000),
    };
    // Threshold sweep on the raw attention score (selection rule = relevance pass && score >= t).
    const sweep: Array<Record<string, number>> = [];
    for (let t = 40; !incomplete && t <= 90; t += 2) {
      let a = 0, b = 0, c = 0, d = 0;
      for (const x of results) {
        if (!x.out || x.r.gold.decision === "either") continue;
        const pred = x.out.relevance === "pass" && x.out.score !== null && x.out.score >= t;
        const g = x.r.gold.decision === "select";
        if (pred && g) a++; else if (pred) b++; else if (g) c++; else d++;
      }
      const P = a / Math.max(1, a + b), R = a / Math.max(1, a + c);
      sweep.push({ t, acc: +((a + d) / Math.max(1, a + b + c + d)).toFixed(3), P: +P.toFixed(3), R: +R.toFixed(3), F1: +((2 * P * R) / Math.max(1e-9, P + R)).toFixed(3), sel: +((a + b) / Math.max(1, a + b + c + d)).toFixed(3) });
    }
    const cases = results.map((x) => ({
      caseId: x.r.caseId,
      title: x.r.material.title,
      stratum: x.r.samplingContext?.samplingStratum ?? null,
      gold: x.r.gold.decision,
      decision: x.out ? (x.out.selected ? "select" : "reject") : null,
      score: x.out?.score ?? null,
      relevance: x.out?.relevance ?? null,
      category: x.out?.category ?? null,
      reason: x.out?.reasonZh ?? null,
      receiptId: x.receiptIds[0] ?? null,
      error: x.error,
      ...(x.pause ? { incomplete: true, deferred: true, pause: x.pause } : x.unstarted ? { incomplete: true, unstarted: true } : {}),
    }));
    report[model] = { summary, sweep, mistakes, cases };
    if (incomplete) break;
  }
  const completedModels = Object.keys(report).filter((model) => !report[model]!.summary.incomplete);
  const unstartedModels = models.filter((model) => !report[model]);
  if (stopped) {
    // A later model can pause after earlier ones succeeded. No part of that incomplete comparison is
    // rankable; retain raw counts/case evidence, but clear every model's published quality metrics.
    for (const result of Object.values(report)) {
      Object.assign(result.summary, { incomplete: true, deferred: result.summary.deferred ?? 0, unstarted: result.summary.unstarted ?? 0, pause: stopped });
      for (const metric of ["accuracy", "precision", "recall", "f1", "selectedRate", "goldSelectRate"]) result.summary[metric] = null;
      result.sweep = [];
    }
  }
  for (const { summary, sweep } of Object.values(report)) {
    console.log(JSON.stringify(summary));
    console.log(sweep.map((s) => `  t=${s.t} acc=${s.acc} P=${s.P} R=${s.R} F1=${s.F1} sel=${s.sel}`).join("\n"));
  }
  const outDir = path.join(REPO_ROOT, ".data/eval");
  mkdirSync(outDir, { recursive: true });
  const splitName = safeReportNamePart(values.split!);
  const file = path.join(outDir, `selection-${splitName}-${sample.length}-${Date.now()}.json`);
  const meta = {
    split: values.split, n: sample.length, seed: Number(values.seed), promptVersion: SELECTION_PROMPT_VERSION, createdAt: new Date().toISOString(),
    ...(stopped ? {
      incomplete: true, pause: stopped, requestedModels: models, completedModels, unstartedModels,
      deferred: Object.values(report).reduce((n, model) => n + Number(model.summary.deferred ?? 0), 0),
      unstarted: Object.values(report).reduce((n, model) => n + Number(model.summary.unstarted ?? 0), 0) + unstartedModels.length * sample.length,
    } : {}),
  };
  writeFileSync(file, JSON.stringify({ meta, models: report }, null, 2));
  console.log(`report: ${file}`);
  if (stopped) {
    console.error("Evaluation incomplete: operational interruption stopped new work; all in-flight calls settled. SelectBench import skipped; no automatic retry was sent.");
    process.exitCode = 2;
  } else if (!values["no-import"]) {
    const run = await importSelectBenchRun({ meta, models: report }, values.label ?? `${values.split} ${sample.length} 条 · ${Object.keys(report).join(" / ")}`, "script:eval-selection");
    console.log(`SelectBench run: ${run.id}`);
  }
} finally {
  await closeDb();
}
