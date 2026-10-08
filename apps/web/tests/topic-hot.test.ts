// Real built SSR/router over a loopback-only fixture API; no collector, database or model calls.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { TopicHotDetail, TopicHotEntry, TopicHotResponse } from "@aihot/contracts/topic-hot";

let web: ChildProcess;
let origin: string;
let logs = "";
let entryCount = 6;
let deadline: number;
let board: TopicHotResponse;
const apiCookies: Array<string | undefined> = [];

function entry(rank: number): TopicHotEntry {
  const at = "2026-10-08T02:00:00.000Z";
  const catalysts = rank === 1 ? [1, 2].map((i) => ({
    itemId: `fixture-${i}`, title: `【虚构测试】公司${i}的独立机器人订单`, summary: "测试材料，金额与履行阶段仍以原文为准。",
    publishedAt: at, sourceName: `测试公告源${i}`, firstParty: true, url: `https://example.invalid/announcement/${i}`,
    storyPublicId: `independent-story-${i}`, clarification: false,
  })) : [];
  return {
    rank, topic: { slug: `fixture-topic-${rank}`, name: `测试题材${rank}`, definition: "【虚构测试】题材关联材料，未接行情。", candidate: rank === 3 },
    heat: 100 - rank, trend: rank === 2 ? "unknown" : rank === 4 ? "up" : "flat", trendPct: rank === 4 ? 25 : null,
    sourceGroupCount: 3, discussionGroupCount: 2, discussionCount: 8, recentDiscussionCount: 2, newSourceGroupCount: 1,
    platformCount: 2, platformNames: ["测试社区", "测试媒体"], sourceNames: ["测试源甲", "测试源乙"],
    storyCount: catalysts.length, reportCount: catalysts.length, evidenceStatus: rank === 2 ? "clarified" : rank === 3 ? "unverified" : rank === 4 ? "mixed" : "first_party",
    latestCatalyst: catalysts[0] ?? null, catalysts, firstSeenAt: at, latestAt: at,
  };
}

const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://api.local");
  apiCookies.push(req.headers.cookie);
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: null }));
  if (url.pathname === "/api/site/timeline") {
    res.setHeader("X-Accel-Expires", `@${deadline + 15}`);
    return res.end(JSON.stringify({ filters: { channel: "all", category: null, tag: null, topic: null }, cards: [], nextCursor: null, refreshAt: new Date((deadline + 15) * 1000).toISOString(), dayCounts: [], hot: null, generatedAt: board.computedAt }));
  }
  if (url.pathname === "/api/site/hot") return res.end(JSON.stringify({ computedAt: board.computedAt, ruleVersion: "fixture", windowHours: 48, entries: [] }));
  if (url.pathname === "/api/site/topic-hot") {
    res.setHeader("X-Accel-Expires", `@${deadline}`);
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60");
    return res.end(JSON.stringify({ ...board, entries: board.entries.slice(0, entryCount) }));
  }
  if (url.pathname === "/api/site/topic-hot/fixture-topic-1") {
    res.setHeader("X-Accel-Expires", `@${deadline}`);
    const { entries, ...header } = board;
    const detail: TopicHotDetail = { board: header, topic: entries[0]!, discussionLinks: [{ sourceName: "【虚构测试】讨论源", url: "https://example.invalid/discussion/1", observedAt: "2026-10-08T02:00:00.000Z" }] };
    return res.end(JSON.stringify(detail));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ code: "not_found" }));
});

before(async () => {
  deadline = Math.floor(Date.now() / 1000) + 45;
  board = {
    computedAt: "2026-10-08T02:00:00.000Z", ruleVersion: "fixture-topic-hot", windowHours: 48, compareHours: 6, halfLifeHours: 24,
    topCount: 5, refreshAt: new Date(deadline * 1000).toISOString(), stale: false, entries: Array.from({ length: 6 }, (_, i) => entry(i + 1)),
    coverage: { countBasis: "source-groups", sourceCount: 3, discussionSourceCount: 2, platformCount: 2, behindSourceCount: 1, behindSourceNames: ["测试落后源"], inputCount: 8, truncated: true, interactionMetricsAvailable: false },
    marketDataAvailable: false,
  };
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  web = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
    env: { ...process.env, WEB_HOST: "127.0.0.1", WEB_PORT: "0", TRUST_PROXY: "false", API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false", FEISHU_CONTENT_PUSH_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`web did not start: ${logs}`)), 15_000);
    web.on("exit", () => { clearTimeout(timeout); reject(new Error(`web exited: ${logs}`)); });
    web.stderr!.on("data", (chunk) => { logs += String(chunk); });
    web.stdout!.on("data", (chunk) => {
      logs += String(chunk);
      const match = logs.match(/"msg":"web started","port":(\d+)/);
      if (match) { origin = `http://127.0.0.1:${match[1]}`; clearTimeout(timeout); resolve(); }
    });
  });
});

after(async () => {
  if (web && web.exitCode === null) { web.kill("SIGTERM"); await once(web, "exit"); }
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

function main(html: string) {
  const match = html.match(/<main\b[\s\S]*?<\/main>/);
  assert.ok(match, "SSR includes the public main content");
  return match[0];
}

test("home renders exactly the first five topics; hot preserves the complete ranking and event section", async () => {
  const response = await fetch(`${origin}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Accel-Expires"), `@${deadline}`, "home uses the earlier topic deadline rather than the timeline deadline");
  const home = main(await response.text());
  assert.match(home, /题材热点 Top5/);
  for (let rank = 1; rank <= 5; rank++) assert.match(home, new RegExp(`href="/hot/topic/fixture-topic-${rank}"`));
  assert.doesNotMatch(home, /fixture-topic-6/);
  const hot = await fetch(`${origin}/hot`);
  assert.equal(hot.status, 200);
  const html = main(await hot.text());
  assert.match(html, /fixture-topic-6/);
  assert.match(html, /完整榜单 · 其余题材/);
  assert.match(html, /独立事件关注榜/);
});

test("coverage gaps, unverified and clarified evidence are explicit; unknown trend never claims a rise", async () => {
  const response = await fetch(`${origin}/hot`);
  const html = main(await response.text());
  assert.match(html, /暂不比较 · 覆盖不足/);
  assert.match(html, /有澄清材料/);
  assert.match(html, /待核实/);
  assert.match(html, /第一方与澄清材料/);
  assert.match(html, /讨论候选题材/);
  assert.match(html, /独立来源组不是讨论人数/);
  assert.match(html, /尚未接入行情数据/);
  assert.match(html, /采集缺口/);
  assert.match(html, /测试落后源/);
  assert.match(html, /本次输入达到处理上限/);
  const unknownCard = html.match(/<article\b[^>]*>[\s\S]*?<\/article>/g)?.find((card) => card.includes("测试题材2"));
  assert.ok(unknownCard);
  assert.doesNotMatch(unknownCard, /升温|↑/);
});

test("short and empty boards show the actual available topics without padding", async () => {
  try {
    entryCount = 2;
    const two = main(await (await fetch(`${origin}/`)).text());
    assert.match(two, /fixture-topic-2/);
    assert.doesNotMatch(two, /fixture-topic-3/);
    entryCount = 0;
    const empty = main(await (await fetch(`${origin}/`)).text());
    assert.match(empty, /暂无可统计的题材热点/);
    assert.doesNotMatch(empty, /href="\/hot\/topic\//);
  } finally { entryCount = 6; }
});

test("topic detail cites materials and keeps different companies as separate event links", async () => {
  const response = await fetch(`${origin}/hot/topic/fixture-topic-1`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Accel-Expires"), `@${deadline}`);
  const html = main(await response.text());
  for (let i = 1; i <= 2; i++) {
    assert.match(html, new RegExp(`href="/story/independent-story-${i}"`));
    assert.match(html, new RegExp(`href="https://example.invalid/announcement/${i}"`));
  }
  assert.match(html, /href="https:\/\/example.invalid\/discussion\/1"/);
  assert.match(html, /公开讨论材料/);
  const missing = await fetch(`${origin}/hot/topic/missing`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("Cache-Control"), "private, no-store");
});

test("public topic responses stay anonymous across reader cookies", async () => {
  const plain = await fetch(`${origin}/hot.data`);
  const signedIn = await fetch(`${origin}/hot.data`, { headers: { cookie: "admin_session=private; aihot_vid=reader" } });
  assert.equal(plain.status, 200);
  assert.equal(signedIn.headers.get("Set-Cookie"), null);
  assert.equal(await signedIn.text(), await plain.text());
  assert.ok(apiCookies.every((cookie) => !cookie));
});
