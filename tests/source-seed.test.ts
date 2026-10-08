// The finance pack imports no demo sources; running the real seed must preserve admin-managed ones.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";

const exec = promisify(execFile);
const T = tag();
const sourceIds = [`finance-seed-${T}-active`, `finance-seed-${T}-paused`];

async function seed() {
  const { stdout } = await exec(process.execPath, ["scripts/seed.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      COLLECT_ENABLED: "false",
      MODEL_CALLS_ENABLED: "false",
      FEISHU_CONTENT_PUSH_ENABLED: "false",
      FEISHU_INTERNAL_ENABLED: "false",
      INDEXNOW_SUBMIT_ENABLED: "false",
    },
    timeout: 30_000,
  });
  assert.match(stdout, /sources: 0 added, 0 already there/);
}

after(async () => {
  await sql`DELETE FROM sources WHERE id = ANY(${sourceIds}::text[])`;
  await closeDb();
});

test("finance seed contains no demo sources and creates no sources", async () => {
  const pack = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8"));
  assert.deepEqual(pack.sources, []);
  const before = await sql`SELECT id FROM sources ORDER BY id`;
  await seed();
  const after = await sql`SELECT id FROM sources ORDER BY id`;
  assert.deepEqual(after, before, "an empty source seed must not create or remove sources");
});

test("repeated finance seed preserves existing source configuration and participation", async () => {
  for (const [index, id] of sourceIds.entries()) {
    await sql`
      INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, enabled, tags, site_fulltext, syndicate_fulltext)
      VALUES (${id}, ${`财经测试来源 ${index}`}, 'rss', ${sql.json({ feedUrl: `https://example.invalid/finance/${index}.xml`, summaryIsBody: true })},
              'T1_5', ${index === 0 ? "editorial" : "isolated"}, 45, ${index === 0}, ${["测试财经信源"]}, false, false)`;
  }
  const before = await sql`SELECT * FROM sources WHERE id = ANY(${sourceIds}::text[]) ORDER BY id`;
  assert.equal(before.length, 2);
  for (let run = 0; run < 2; run += 1) {
    await seed();
    const after = await sql`SELECT * FROM sources WHERE id = ANY(${sourceIds}::text[]) ORDER BY id`;
    assert.deepEqual(after, before, "seed must preserve all admin-managed fields, including paused sources");
  }
});
