// Run only in the isolated 7C Docker fixture; create reports, then verify after container recreation.
import { runStorageEvaluation, type StorageReport } from "./selection-eval-storage-fixture.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { importSelectBenchRun } from "@aihot/backend/admin/selectbench";

const dir = path.resolve(config.dataDir);
assert.equal(process.platform, "linux");
assert.notEqual(process.getuid!(), 0, "exercise real non-root filesystem permissions");
assert.equal(dir, "/data", "this fixture may only write its dedicated Docker volume");
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
async function counts() {
  const [row] = await sql`SELECT (SELECT count(*)::int FROM receipts) AS receipts,
    (SELECT count(*)::int FROM receipt_attempts) AS attempts, (SELECT count(*)::int FROM selectbench_runs) AS runs,
    (SELECT count(*)::int FROM selectbench_results) AS results, (SELECT count(*)::int FROM audit_log WHERE action='selectbench.import') AS imports`;
  return row!;
}
async function rejectIncomplete(report: StorageReport) {
  assert.equal(report.meta.incomplete, true);
  for (const model of Object.values(report.models)) {
    assert.equal(model.summary.incomplete, true);
    for (const key of ["accuracy", "precision", "recall", "f1", "selectedRate", "goldSelectRate"]) assert.equal(model.summary[key], null);
    assert.deepEqual(model.sweep, []);
  }
  const before = await counts();
  await assert.rejects(importSelectBenchRun(report, "recreated incomplete fixture", "7c-docker-test"),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 400);
  assert.deepEqual(await counts(), before, "manual incomplete import writes nothing");
}

try {
  if (process.argv[2] === "create") {
    const before = await counts();
    const complete = await runStorageEvaluation(dir);
    assert.equal(complete.code, 0, complete.stderr); assert.ok(complete.file); assert.ok(complete.report);
    assert.equal(path.dirname(complete.file), "/data/eval");
    assert.deepEqual(complete.hits, { prefilter: 1, score: 2 });
    assert.equal(complete.report.models["glm-5.3-flash-selection"]!.summary.accuracy, 1);
    const afterComplete = await counts();
    assert.equal(afterComplete.runs, before.runs + 1); assert.equal(afterComplete.results, before.results + 1);
    assert.equal(afterComplete.imports, before.imports + 1);
    const interrupted = await runStorageEvaluation(dir, true);
    assert.equal(interrupted.code, 2, interrupted.stderr); assert.ok(interrupted.file); assert.ok(interrupted.report);
    assert.equal(path.dirname(interrupted.file), "/data/eval");
    assert.deepEqual(interrupted.hits, { prefilter: 1, score: 1 });
    assert.equal((await counts()).runs, afterComplete.runs, "interruption skips automatic import");
    await rejectIncomplete(interrupted.report);

    const unwritable = path.join(dir, "unwritable"); mkdirSync(unwritable); chmodSync(unwritable, 0o555);
    try {
      for (const target of [unwritable, "/app/7c-unwritable-output"]) {
        const snapshot = await counts();
        const result = await runStorageEvaluation(target);
        assert.equal(result.code, 1, result.stderr); assert.equal(result.file, undefined);
        assert.match(result.stderr, /Evaluation output directory is not writable/);
        // Recursive mkdir on a read-only overlay can surface ENOENT on Node/Linux. The
        // chmod case must still prove EACCES; Docker inspect separately proves the read-only mount.
        assert.match(result.stderr, target === unwritable ? /EACCES/ : /EROFS|ENOENT/);
        assert.deepEqual(result.hits, { prefilter: 0, score: 0 });
        assert.deepEqual(await counts(), snapshot);
        assert.doesNotMatch(result.stderr, /dummy-storage-(?:prefilter|score)/);
      }
    } finally { chmodSync(unwritable, 0o755); }
    assert.deepEqual(readdirSync("/data/eval").sort(), [path.basename(complete.file), path.basename(interrupted.file)].sort());
    const manifest = { uid: process.getuid!(), gid: process.getgid!(), owner: statSync(dir).uid,
      reports: [complete, interrupted].map(result => ({ name: path.basename(result.file!), sha256: digest(result.file!), exitCode: result.code, hits: result.hits })),
      counts: await counts() };
    writeFileSync(path.join(dir, "7c-manifest.json"), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify({ stage: "create", ...manifest }));
  } else {
    assert.equal(process.argv[2], "verify");
    const manifest = JSON.parse(readFileSync(path.join(dir, "7c-manifest.json"), "utf8")) as {
      reports: Array<{ name: string; sha256: string; exitCode: number }>; counts: Awaited<ReturnType<typeof counts>> };
    assert.equal(manifest.reports.length, 2);
    for (const entry of manifest.reports) {
      assert.equal(path.basename(entry.name), entry.name);
      const file = path.join(dir, "eval", entry.name);
      assert.equal(digest(file), entry.sha256, "recreated container sees identical report bytes");
      const report = JSON.parse(readFileSync(file, "utf8")) as StorageReport;
      if (entry.exitCode === 2) await rejectIncomplete(report);
      else { assert.equal(entry.exitCode, 0); assert.equal(report.meta.incomplete, undefined); }
    }
    assert.deepEqual(await counts(), manifest.counts, "recreation must not resend or import evaluation work");
    console.log(JSON.stringify({ stage: "verify", uid: process.getuid!(), reports: manifest.reports, counts: manifest.counts }));
  }
} finally { await closeDb(); }
