import { runStorageEvaluation } from "./selection-eval-storage-fixture.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";

const roots: string[] = [];
function tempRoot() { const dir = mkdtempSync(path.join(tmpdir(), "eval storage ")); roots.push(dir); return dir; }
after(async () => { await closeDb(); for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });
async function counts() {
  const [row] = await sql`SELECT (SELECT count(*)::int FROM receipts) AS receipts,
    (SELECT count(*)::int FROM receipt_attempts) AS attempts, (SELECT count(*)::int FROM selectbench_runs) AS runs`;
  return row!;
}

for (const obstruction of ["data root", "eval child"]) test(`unwritable evaluation ${obstruction} fails before any provider request or receipt`, async () => {
  const root = tempRoot();
  const dataDir = path.join(root, "data");
  if (obstruction === "data root") writeFileSync(dataDir, "file, not a directory");
  else { mkdirSync(dataDir); writeFileSync(path.join(dataDir, "eval"), "file, not a directory"); }
  const before = await counts();
  const result = await runStorageEvaluation(dataDir);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /Evaluation output directory is not writable/);
  assert.match(result.stderr, /AIHOT_DATA_DIR.*No model requests were sent/);
  assert.deepEqual(result.hits, { prefilter: 0, score: 0 });
  assert.equal(result.file, undefined); assert.equal(result.report, null);
  assert.deepEqual(await counts(), before, "preflight must not create receipt, attempt or SelectBench records");
  assert.doesNotMatch(result.stderr, /dummy-storage-(?:prefilter|score)/);
});

test("configured output with spaces and a trailing separator contains the normal report and no write probes", async () => {
  const dataDir = path.join(tempRoot(), "persistent reports") + path.sep;
  const result = await runStorageEvaluation(dataDir);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.file); assert.ok(result.report);
  assert.equal(path.dirname(result.file), path.resolve(dataDir, "eval"));
  assert.deepEqual(result.hits, { prefilter: 1, score: 2 });
  assert.equal(result.report.models["glm-5.3-flash-selection"]!.summary.accuracy, 1);
  assert.match(result.stdout, /SelectBench run:/);
  assert.deepEqual(readdirSync(path.dirname(result.file)), [path.basename(result.file)]);
});

test("relative AIHOT_DATA_DIR keeps host cwd semantics and reports an absolute path", async () => {
  mkdirSync(path.join(REPO_ROOT, ".data"), { recursive: true });
  const dataDir = mkdtempSync(path.join(REPO_ROOT, ".data", "eval-storage-")); roots.push(dataDir);
  const relative = path.relative(REPO_ROOT, dataDir);
  assert.equal(path.isAbsolute(relative), false);
  const result = await runStorageEvaluation(relative);
  assert.equal(result.code, 0, result.stderr); assert.ok(result.file);
  assert.equal(path.isAbsolute(result.file), true);
  assert.equal(path.dirname(result.file), path.join(dataDir, "eval"));
  assert.deepEqual(result.hits, { prefilter: 1, score: 2 });
});
