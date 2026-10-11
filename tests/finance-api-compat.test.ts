// Finance vocabulary is a read projection, never a rewrite of historical publications or ledgers.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { selectedChanges, selectedSnapshot } from "@aihot/backend/publication/v1";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { FEATURES } from "@aihot/industry/features";
import { SCHEDULES } from "../apps/worker/src/schedules.ts";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SOURCE = `finance-compat-${T}`;
const app = await buildApp();
const ids: string[] = [];
const now = new Date("2200-01-01T00:00:00Z");
after(async () => {
  await app.close();
  if (ids.length) {
    await sql`DELETE FROM pgboss.job WHERE data->>'articleId' = ANY(${ids}::text[])`;
    await sql`DELETE FROM selected_ledger WHERE article_id = ANY(${ids}::text[])`;
    await sql`DELETE FROM articles WHERE id = ANY(${ids}::text[])`;
  }
  await sql`DELETE FROM sources WHERE id=${SOURCE}`;
  await stopBoss();
  await closeDb();
});

test("finance pack disables AI modules in routes, discovery and schedules", async () => {
  assert.deepEqual(FEATURES, { leaderboard: false, codexResetMonitor: false });
  assert.ok(!SCHEDULES.some(s => s.name.startsWith("leaderboard.") || s.name.startsWith("monitor.")));
  for (const url of ["/api/site/leaderboard/boards/overall", "/api/site/leaderboard/rules", "/api/v1/codex-resets", "/api/v1/agent/codex-resets"]) {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 404, url);
  }
  const spec = await app.inject({ method: "GET", url: "/openapi-v1.json" });
  assert.equal(spec.statusCode, 200);
  assert.ok(!Object.keys(spec.json().paths).some(p => p.includes("codex-resets")));
  const parameter = spec.json().paths["/api/v1/items"].get.parameters.find((p: any) => p.name === "category");
  assert.equal(parameter.schema.type, "string");
  assert.deepEqual(parameter.schema.examples, [...CATEGORY_KEYS]);
  assert.ok(parameter.schema.description.includes(CATEGORY_KEYS.join(", ")));
  assert.deepEqual(spec.json().components.schemas.Item.properties.category.examples, [...CATEGORY_KEYS]);
  for (const url of ["/llms.txt", "/api/v1/agent"]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200);
    assert.doesNotMatch(response.body, /\/codex-resets|\/leaderboard/);
  }
});

test("finance categories reach API and RSS; obsolete categories are null without changing storage", async () => {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES(${SOURCE},'财经兼容测试','rss','T1','editorial','2100-01-01')`;
  const starts = await Promise.all(["default", "minimal"].map(fields => selectedSnapshot({ fields: fields as "default" | "minimal", limit: 1000, page: null }, now)));
  for (const category of [...CATEGORY_KEYS, "ai-models", "tip", "opinion"]) {
    const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.test/${T}/${category}`, title: `财经测试 ${T} ${category}`, bodyText: "虚构测试：公司公布经营数据。", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
    ids.push(articleId);
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
      VALUES(${articleId},1,'rule','pass',${category},${`财经测试 ${T} ${category}`},'虚构测试摘要',90,true)`;
    await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
    // Simulate an immutable payload created by the old industry pack.
    await sql`UPDATE selected_ledger SET payload=jsonb_set(payload,'{category}',${sql.json(category)}) WHERE article_id=${articleId}`;
  }
  const saved = await sql`SELECT seq,article_id,payload FROM selected_ledger WHERE article_id=ANY(${ids}::text[]) ORDER BY seq`;
  for (const [index, category] of [...CATEGORY_KEYS, "ai-models", "tip", "opinion"].entries()) {
    const item = await app.inject({ method: "GET", url: `/api/site/items/${ids[index]}` });
    assert.equal(item.statusCode, 200);
    assert.equal(item.json().category, CATEGORY_KEYS.includes(category as typeof CATEGORY_KEYS[number]) ? category : null);
  }
  for (const [index, category] of CATEGORY_KEYS.entries()) {
    const response = await app.inject({ method: "GET", url: `/api/v1/items?category=${category}&q=${T}` });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().items.map((i: any) => i.id), [ids[index]]);
    const feed = await app.inject({ method: "GET", url: `/feed/category/${category}.xml` });
    assert.equal(feed.statusCode, 200);
    assert.ok(feed.body.includes(ids[index]!));
    const unchanged = await app.inject({ method: "GET", url: `/api/v1/items?category=${category}&q=${T}`, headers: { "if-none-match": String(response.headers.etag) } });
    assert.equal(unchanged.statusCode, 304);
  }
  for (const category of ["ai-models", "tip", "opinion"]) {
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/items?category=${category}` })).statusCode, 400);
  }
  const all = await app.inject({ method: "GET", url: `/api/v1/items?q=${T}` });
  assert.equal(all.statusCode, 200);
  assert.equal(all.json().query.category, null, "omitting category still means all categories");
  assert.equal(all.json().items.length, ids.length);
  for (const start of starts) {
    const changes = await selectedChanges({ cursor: start.cursor, limit: 100 }, now);
    const ours = changes.changes.filter(change => change.op === "upsert" && ids.includes(change.item.id));
    assert.equal(ours.length, ids.length);
    for (const change of ours) if (change.op === "upsert") {
      const expected = saved.find(row => row.article_id === change.item.id)!.payload.category;
      assert.equal(change.item.category, CATEGORY_KEYS.includes(expected) ? expected : null);
    }
    const snapshot = await selectedSnapshot({ fields: start.fields, limit: 1000, page: null }, now);
    assert.equal(snapshot.items.filter(item => ids.includes(item.id)).length, ids.length);
    for (const item of snapshot.items.filter(item => ids.includes(item.id))) {
      const expected = saved.find(row => row.article_id === item.id)!.payload.category;
      assert.equal(item.category, CATEGORY_KEYS.includes(expected) ? expected : null);
    }
  }
  assert.deepEqual(await sql`SELECT seq,article_id,payload FROM selected_ledger WHERE article_id=ANY(${ids}::text[]) ORDER BY seq`, saved, "readers preserve ledger sequence and raw payload");
  const raw = await sql`SELECT category FROM publications WHERE article_id=ANY(${ids}::text[])`;
  assert.deepEqual(raw.map(row => row.category).sort(), [...CATEGORY_KEYS, "ai-models", "tip", "opinion"].sort());
});
