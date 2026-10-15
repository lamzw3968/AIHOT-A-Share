// Real evaluation CLI + receipt/budget path, backed only by loopback fake providers.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect, promisify } from "node:util";
import { REPO_ROOT } from "@aihot/backend/config";

const exec = promisify(execFile);
export interface StorageReport {
  meta: { incomplete?: boolean };
  models: Record<string, { summary: Record<string, unknown>; sweep: unknown[] }>;
}

export async function runStorageEvaluation(dataDir: string, interrupted = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "eval-storage-gold-"));
  const prefilter = await stub(() => ({ choices: [{ message: { content: '{"label":"PASS","reason":"fictional finance"}' } }] }));
  const score = await stub(() => interrupted
    ? new Reply(429, { error: { type: "rate_limit", message: "isolated fake provider limit" } })
    : { choices: [{ message: { content: '{"attentionScore":80}' } }], usage: { prompt_tokens: 20, completion_tokens: 10 } });
  try {
    const marker = tag();
    const gold = path.join(dir, "gold.jsonl");
    writeFileSync(gold, JSON.stringify({ caseId: marker,
      material: { title: `Fictional contract ${marker}`, originalTitle: null, publishedAt: null, sourceName: "Fictional source",
        bodyZh: null, bodyOriginal: `Fictional company ${marker} disclosed an order with amount and dates. `.repeat(8) },
      sourceFacts: { sourceKind: "rss", sourceTier: "T1", firstParty: true, language: "en" }, gold: { decision: "select" } }));
    let code = 0, stdout = "", stderr = "";
    try {
      const result = await exec(process.execPath, ["scripts/eval-selection.ts", "--gold", gold,
        "--models", "glm-5.3-flash-selection", "--concurrency", "1"], {
        cwd: REPO_ROOT, timeout: 25_000,
        env: { ...process.env, AIHOT_DATA_DIR: dataDir, MODEL_CALLS_ENABLED: "true", COLLECT_ENABLED: "false",
          FEISHU_CONTENT_PUSH_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false",
          PREFILTER_MODEL: "qwen3.7-flash", DASHSCOPE_BASE_URL: `${prefilter.url}/v1`, DASHSCOPE_API_KEY: "dummy-storage-prefilter",
          ZHIPU_BASE_URL: `${score.url}/v1`, ZHIPU_API_KEY: "dummy-storage-score" },
      });
      stdout = result.stdout; stderr = result.stderr;
    } catch (error) {
      const result = error as { code?: number; stdout?: string; stderr?: string; signal?: string; killed?: boolean };
      if (typeof result.code !== "number" || result.code > 255 || result.signal || result.killed) {
        console.error("storage evaluation abnormal exit", inspect(error, { depth: null, showHidden: true, maxStringLength: null }));
      }
      assert.equal(typeof result.code, "number", "CLI must exit normally without a timeout or native crash");
      code = result.code!; stdout = result.stdout ?? ""; stderr = result.stderr ?? "";
    }
    const file = stdout.split(/\r?\n/).find(line => line.startsWith("report: "))?.slice(8);
    const report = file ? JSON.parse(readFileSync(file, "utf8")) as StorageReport : null;
    return { code, stdout, stderr, file, report, hits: { prefilter: prefilter.hits(), score: score.hits() } };
  } finally {
    await Promise.all([prefilter.close(), score.close()]);
    rmSync(dir, { recursive: true, force: true });
  }
}
