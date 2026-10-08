import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { HOT_TOPICS } from "@aihot/industry/hot-topics";
import { sql, closeDb } from "@aihot/backend/db";
import { buildTopicHotBoard, computeTopicHotRanking, isTopicClarification, safeTopicUrl, type TopicMaterial, type TopicSource } from "@aihot/backend/events/topic-heat";
import { loadTopicHot, loadTopicHotDetail } from "@aihot/backend/publication/topic-hot";
import { SCHEDULES } from "../apps/worker/src/schedules.ts";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const HOUR = 3_600_000;
const at = new Date("2026-10-08T08:00:00Z");
const old = new Date(at.getTime() - 100 * 24 * HOUR);
const source: TopicSource = { id: "sample", name: "虚构来源", discussion: true, since: old,
  scheduled: false, lastOk: null, graceMs: 90 * 60_000 };
function material(overrides: Partial<TopicMaterial> = {}): TopicMaterial {
  return { id: "sample", title: "A股液冷板块讨论", summary: null, body: null, tags: [], url: "https://xueqiu.com/example",
    observedAt: new Date(at.getTime() - HOUR), sourceId: source.id, sourceName: source.name, sourceTags: [],
    group: "same-owner", sourceSince: old, discussion: true, publicNow: true, firstParty: false, storyPublicId: null, ...overrides };
}
const liquid = (b: ReturnType<typeof buildTopicHotBoard>) => b.entries.find((e) => e.topic.slug === "finance-liquid-cooling")!;

test("topic heat deduplicates material and owner groups; fine themes suppress the same material's broad parent", () => {
  const one = material();
  const board = buildTopicHotBoard([one, one, material({ id: "repost", observedAt: at }), material({ id: "second", group: "independent", sourceId: "second" })], [source], at);
  const entry = liquid(board);
  assert.equal(entry.sourceGroupCount, 2);
  assert.equal(entry.discussionCount, 3);
  assert.equal(entry.discussionGroupCount, 2);
  assert.equal(entry.platformCount, 1);
  assert.equal(entry.heat, Math.round((1 + 0.5 ** (1 / 24)) * 100) / 10);
  assert.equal(entry.evidenceStatus, "unverified");
  assert.equal(entry.latestCatalyst, null);
  assert.ok(!board.entries.some((e) => e.topic.slug === "finance-ai-compute"));
  assert.equal(board.marketDataAvailable, false);
  assert.equal(board.coverage.countBasis, "source-groups");
  assert.equal(board.coverage.interactionMetricsAvailable, false);
});

test("all themes remain ranked; Top5 is a presentation limit, not a storage filter", () => {
  const rows = HOT_TOPICS.slice(0, 8).map((t, i) => material({ id: `theme-${i}`, title: `A股 ${t.name} 板块`, group: `group-${i}` }));
  const board = buildTopicHotBoard(rows, [source], at);
  assert.equal(board.topCount, 5);
  assert.equal(board.entries.length, 8);
  assert.deepEqual(board.entries.map((e) => e.rank), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("internet-first unknown topics enter the candidate pool without inventing fact evidence", () => {
  const board = buildTopicHotBoard([material({ title: "A股板块讨论 #星际纤维#" })], [source], at);
  const entry = board.entries[0]!;
  assert.equal(entry.topic.name, "星际纤维");
  assert.match(entry.topic.slug, /^signal-[a-f0-9]{16}$/);
  assert.equal(entry.topic.candidate, true);
  assert.equal(entry.evidenceStatus, "unverified");
  assert.equal(entry.storyCount, 0);
  assert.equal(entry.reportCount, 0);
  assert.equal(entry.catalysts.length, 0);
  assert.equal(buildTopicHotBoard([material({ title: "娱乐话题 #明星穿搭#" })], [source], at).entries.length, 0);
});

test("growth requires a stable observed cohort; missing or new sources and stale/capped snapshots stay unknown", () => {
  const rows = [material({ id: "old", observedAt: new Date(at.getTime() - 12 * HOUR) }), material({ id: "new", group: "new-group" })];
  assert.equal(liquid(buildTopicHotBoard(rows, [source], at)).trend, "up");
  assert.equal(liquid(buildTopicHotBoard(rows, [source], at)).newSourceGroupCount, 1);
  assert.equal(liquid(buildTopicHotBoard(rows.map((r) => ({ ...r, sourceSince: at })), [source], at)).trend, "unknown");
  const behind = buildTopicHotBoard(rows, [{ ...source, scheduled: true }], at);
  assert.equal(liquid(behind).trend, "unknown");
  assert.equal(behind.coverage.behindSourceCount, 1);
  assert.equal(liquid(buildTopicHotBoard(rows, [source], at, { truncated: true })).trend, "unknown");
  const stale = buildTopicHotBoard(rows, [source], at, { now: new Date(at.getTime() + 15 * 60_000) });
  assert.equal(stale.stale, true);
  assert.equal(liquid(stale).trend, "unknown");
});

test("source time, expiry, public visibility and safe links govern eligibility", () => {
  const rows = [material({ id: "future", observedAt: new Date(at.getTime() + 1) }),
    material({ id: "expired", observedAt: new Date(at.getTime() - 48 * HOUR) }),
    material({ id: "private", publicNow: false }), material({ id: "token", url: "https://example.test/?token=private" })];
  assert.equal(buildTopicHotBoard(rows, [source], at).entries.length, 0);
  assert.equal(safeTopicUrl("https://user:password@example.test/news"), null);
  assert.equal(safeTopicUrl("javascript:alert(1)"), null);
  assert.equal(safeTopicUrl("https://example.test/article?utm_source=demo"), "https://example.test/article?utm_source=demo");
  const expired = buildTopicHotBoard([material({ observedAt: new Date(at.getTime() - 47 * HOUR) })], [source], at,
    { now: new Date(at.getTime() + 2 * HOUR) });
  assert.equal(expired.entries.length, 0);
});

test("discussion attention and first-party denial are separate from fact confirmation; stories stay separate", () => {
  const denial = material({ id: "denial", title: "公司澄清：液冷订单传闻不属实", summary: "未签署相关合同。", discussion: false, firstParty: true, storyPublicId: "denial-story" });
  const rumor = material();
  const board = buildTopicHotBoard([rumor, denial], [source], at);
  assert.equal(liquid(board).evidenceStatus, "clarified");
  assert.equal(liquid(board).latestCatalyst!.clarification, true);
  assert.equal(isTopicClarification({ title: "公司澄清：液冷项目属实", summary: "有正式合同。", firstParty: true }), false);
  assert.equal(isTopicClarification({ title: "液冷合同终止", summary: "合同到期终止。", firstParty: true }), false);
  const confirmed = material({ id: "other-company", title: "另一公司液冷产品供货公告", summary: "已签约；与被否认的公司无关。", discussion: false, firstParty: true, storyPublicId: "different-story" });
  const mixed = liquid(buildTopicHotBoard([rumor, denial, confirmed], [source], at));
  assert.equal(mixed.evidenceStatus, "mixed");
  assert.equal(mixed.storyCount, 2);
  assert.deepEqual(new Set(mixed.catalysts.map((c) => c.storyPublicId)), new Set(["denial-story", "different-story"]));
});

const sources: string[] = [];
const ids: string[] = [];
const rankings: number[] = [];
after(async () => {
  if (rankings.length) await sql`DELETE FROM topic_hot_rankings WHERE id=ANY(${rankings}::bigint[])`;
  if (ids.length) await sql`DELETE FROM articles WHERE id=ANY(${ids}::text[])`;
  if (sources.length) await sql`DELETE FROM sources WHERE id=ANY(${sources}::text[])`;
  await closeDb();
});
async function dbSource(mode: "editorial" | "hot_signal") {
  const id = `topic-${mode}-${T}`;
  sources.push(id);
  await sql`INSERT INTO sources(id,name,kind,participation_mode,enabled,created_at) VALUES(${id},${'虚构测试'+mode},'external',${mode},false,${old})`;
  return id;
}
async function dbItem(sourceId: string, suffix: string, title: string, date: Date) {
  const id = `topic-${T}-${suffix}`; ids.push(id);
  await sql`INSERT INTO articles(id,source_id,identity_key,title,url,discovered_at,timeline_at,published_at,body_text)
    VALUES(${id},${sourceId},${id},${title},${'https://example.invalid/'+id},${date},${date},${date},'虚构测试材料')`;
  return id;
}

test("worker snapshot and publication readers respect release gates, withdrawals, source roles and anonymous ETags without writes", async () => {
  const stamp = new Date(Date.now() - 1000);
  const signalSource = await dbSource("hot_signal");
  const reportSource = await dbSource("editorial");
  const signal = await dbItem(signalSource, "signal", "虚构测试 A股 #星际纤维# 板块讨论", stamp);
  const report = await dbItem(reportSource, "report", "虚构测试液冷产品公告", stamp);
  const release = new Date(stamp.getTime() + 60_000);
  await sql`INSERT INTO publications(article_id,source_id,title,summary,url,discovered_at,timeline_at,sort_at,channel,eligible,selected,visible_after,tags)
    VALUES(${report},${reportSource},'虚构测试液冷产品公告','虚构公告；仅供测试。',${'https://example.invalid/'+report},${stamp},${stamp},${stamp},'news',true,true,${release},${['液冷']})`;
  const snapshot = await computeTopicHotRanking(stamp); rankings.push(snapshot.id);
  const before = await loadTopicHot(stamp);
  assert.ok(before.entries.some((e) => e.topic.name === "星际纤维"));
  assert.ok(!before.entries.some((e) => e.topic.slug === "finance-liquid-cooling"));
  const [saved] = await sql`SELECT article_ids FROM topic_hot_rankings WHERE id=${snapshot.id}`;
  const [pending] = await sql<{ at: Date | null }[]>`SELECT min(p.visible_after) AS at FROM publications p
    JOIN sources s ON s.id=p.source_id WHERE p.article_id=ANY(${saved!.article_ids}::text[])
      AND p.visibility='public' AND p.eligible AND p.selected AND p.visible_after>${stamp}
      AND s.participation_mode='editorial'`;
  assert.equal(before.refreshAt, new Date(Math.min(stamp.getTime() + 300_000, pending!.at!.getTime())).toISOString(),
    "the public cache opens at the earliest selected gate, including other materials in scope");
  const afterRelease = await loadTopicHot(release);
  assert.ok(afterRelease.entries.some((e) => e.topic.slug === "finance-liquid-cooling"));
  const detail = await loadTopicHotDetail(before.entries.find((e) => e.topic.name === "星际纤维")!.topic.slug, stamp);
  assert.equal(detail!.discussionLinks.length, 1);
  assert.equal(detail!.discussionLinks[0]!.url, `https://example.invalid/${signal}`);
  assert.ok(!JSON.stringify(detail).includes("虚构测试材料"), "discussion bodies never leave the read layer");
  assert.equal(await loadTopicHotDetail("finance-missing", stamp), null);
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${report}`;
  assert.ok(!(await loadTopicHot(release)).entries.some((e) => e.topic.slug === "finance-liquid-cooling"));
  await sql`UPDATE sources SET participation_mode='isolated' WHERE id=${signalSource}`;
  assert.ok(!(await loadTopicHot(stamp)).entries.some((e) => e.topic.name === "星际纤维"));
  assert.ok(SCHEDULES.some((s) => s.name === "topics.rank" && s.cron === "*/5 * * * *"));
  const app = await buildApp();
  try {
    const [counts] = await sql`SELECT (SELECT count(*) FROM receipts) AS receipts,(SELECT count(*) FROM topic_hot_rankings) AS snapshots`;
    const one = await app.inject({ method: "GET", url: "/api/site/topic-hot" });
    assert.equal(one.statusCode, 200);
    assert.match(String(one.headers["cache-control"]), /public|no-cache/);
    const two = await app.inject({ method: "GET", url: "/api/site/topic-hot", headers: { cookie: "admin_session=private" } });
    assert.equal(two.body, one.body);
    assert.equal(two.headers["set-cookie"], undefined);
    assert.equal((await app.inject({ method: "GET", url: "/api/site/topic-hot", headers: { "if-none-match": String(one.headers.etag) } })).statusCode, 304);
    assert.equal((await app.inject({ method: "GET", url: "/api/site/topic-hot/finance-missing" })).statusCode, 404);
    const [unchanged] = await sql`SELECT (SELECT count(*) FROM receipts) AS receipts,(SELECT count(*) FROM topic_hot_rankings) AS snapshots`;
    assert.deepEqual(unchanged, counts, "page reads do not call models or create rankings");
  } finally { await app.close(); }
});
