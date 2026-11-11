import { listenForFetch } from "./http-fixture.ts";
// Fixed, fictional feeds and a loopback provider: this proves material/queue contracts, not model quality.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { fetchRss } from "@aihot/backend/sources/rss";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import type { Candidate, SourceRow } from "@aihot/backend/sources/types";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { analyzeArticle, buildScoreInput, runAnalysis } from "@aihot/backend/editorial/analyze";
import { buildMaterial, loadAnalyzeInput, type AnalyzeInputArticle } from "@aihot/backend/editorial/input";
import { prefilterUser, renderContext } from "@aihot/backend/editorial/writing";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const SHORT = "【虚构测试】甲公司公告签署2亿元储能设备合同，履行期限12个月。合同尚未履行，不构成收入确认或投资建议。";
const fixtures = new Map<string, { type: string; body: string }>();
let pageRequests = 0;
const server = http.createServer((req, res) => {
  const path = req.url ?? "/";
  if (path.startsWith("/article/")) {
    pageRequests++;
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><head><title>测试页面</title></head><body><p>请登录后阅读全文。</p></body></html>");
    return;
  }
  const fixture = fixtures.get(path);
  res.writeHead(fixture ? 200 : 404, { "content-type": fixture?.type ?? "text/plain" });
  res.end(fixture?.body ?? "No fixture");
});
await listenForFetch(server);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const oldPrivate = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true; // Only this isolated test process may fetch its loopback fixtures.
after(async () => {
  config.allowPrivateNetworkFetch = oldPrivate;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

const source = (path: string, extra: Record<string, unknown> = {}): SourceRow => ({
  id: `short-news-${T}`, name: "虚构短快讯测试", kind: "rss", tier: "T1", participation_mode: "editorial",
  first_party: false, enabled: true, interval_minutes: 30, fail_count: 0, cursor: null,
  config: { feedUrl: base + path, ...extra },
});
async function rss(name: string, content: string | null, description: string | null, extra: Record<string, unknown> = {}): Promise<Candidate> {
  const path = `/rss-${name}.xml`;
  fixtures.set(path, { type: "application/rss+xml", body: `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>虚构测试</title><item><title>虚构甲公司签署订单 ${T}</title><link>${base}/article/${name}-${T}</link>${content === null ? "" : `<content:encoded><![CDATA[<p>${content}</p>]]></content:encoded>`}${description === null ? "" : `<description><![CDATA[<p>${description}</p>]]></description>`}</item></channel></rss>` });
  const result = await fetchRss(source(path, extra));
  assert.equal(result.candidates.length, 1);
  return result.candidates[0]!;
}
function input(candidate: Candidate): AnalyzeInputArticle {
  return {
    id: `short-input-${T}`, revision: 1, title: candidate.title, url: candidate.url, author: null, publishedAt: null,
    bodyText: candidate.bodyText ?? null, excerpt: candidate.excerpt ?? null, bodyStatus: candidate.bodyStatus,
    xPost: null, media: [], source: { name: "虚构短快讯测试", kind: "rss", tier: "T1", firstParty: false },
  };
}

test("short RSS content:encoded without description survives as an excerpt, not confirmed full text", async () => {
  const candidate = await rss("short-content", SHORT, null);
  assert.equal(candidate.excerpt, SHORT);
  assert.deepEqual([candidate.bodyStatus, candidate.bodyText, candidate.bodyHtml], ["pending", null, null]);
});

test("short Atom content without summary survives as an excerpt", async () => {
  fixtures.set("/atom.xml", { type: "application/atom+xml", body: `<feed xmlns="http://www.w3.org/2005/Atom"><title>虚构测试</title><entry><id>urn:short:${T}</id><title>虚构甲公司订单</title><link href="${base}/article/atom-${T}"/><content type="html"><![CDATA[<p>${SHORT}</p>]]></content></entry></feed>` });
  const { candidates } = await fetchRss(source("/atom.xml"));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.excerpt, SHORT);
  assert.deepEqual([candidates[0]!.bodyStatus, candidates[0]!.bodyText], ["pending", null]);
});

test("RSS descriptions, 280/281 boundary and editorial teasers retain their existing body rules", async () => {
  for (const extra of [{}, { summaryIsBody: true }]) {
    const candidate = await rss(`description-${Object.keys(extra).length}`, null, SHORT, extra);
    assert.equal(candidate.excerpt, SHORT);
    assert.deepEqual([candidate.bodyStatus, candidate.bodyText], ["pending", null]);
  }
  const short = await rss("boundary-280", "财".repeat(280), null);
  assert.equal(short.excerpt, "财".repeat(280));
  assert.deepEqual([short.bodyStatus, short.bodyText], ["pending", null]);
  const full = await rss("boundary-281", "财".repeat(281), null);
  assert.deepEqual([full.bodyStatus, full.bodyText, full.excerpt], ["ok", "财".repeat(281), null]);
  const long = await rss("long", "财".repeat(2100), null);
  assert.deepEqual([long.bodyStatus, long.bodyText?.length, long.excerpt], ["ok", 2100, null]);
  const teaserText = `${"财".repeat(281)} Read more`;
  const teaser = await rss("teaser", teaserText, null);
  assert.deepEqual([teaser.bodyStatus, teaser.bodyText, teaser.excerpt], ["pending", null, teaserText]);
  const summary = await rss("summary-cap", null, "财".repeat(2100));
  assert.equal(summary.excerpt?.length, 2000);
  const empty = await rss("empty-content", "", null);
  assert.equal(empty.excerpt, null, "empty content must not invent an excerpt");
});

test("JSON short summaryIsBody uses the configured full body and RSS excerpts reach every analysis input", async () => {
  fixtures.set("/items.json", { type: "application/json", body: JSON.stringify({ items: [{ title: "虚构甲公司订单", url: `${base}/article/json-${T}`, content_text: SHORT }] }) });
  const candidates = await fetchJsonList({ ...source(""), kind: "json_list", config: { url: `${base}/items.json`, itemsPath: "items", titlePaths: ["title"], urlTemplate: "{raw:url}", summaryPaths: ["content_text"], summaryIsBody: true } });
  assert.deepEqual([candidates[0]!.bodyStatus, candidates[0]!.bodyText, candidates[0]!.excerpt], ["ok", SHORT, SHORT]);
  const a = input(await rss("input", SHORT, null));
  a.bodyStatus = "unconfirmed";
  assert.ok(buildMaterial(a).includes(SHORT));
  assert.ok(buildScoreInput(a).includes(SHORT));
  assert.ok(JSON.parse(prefilterUser(a)).includes(SHORT));
  assert.match(renderContext(a), /仅摘要（feed 未提供完整正文）/);
  assert.ok(!renderContext(a).includes("抓取失败，仅标题可用"));
});

test("failed page extraction preserves short feed evidence, analysis proceeds and recollection does not extract again", async () => {
  const candidate = await rss("flow", SHORT, null);
  assert.equal(candidate.excerpt, SHORT, "regression must fail before the RSS preservation fix");
  const sourceId = `short-news-flow-${T}`;
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,next_fetch_at) VALUES (${sourceId},'虚构短快讯流程','rss','T1','editorial','2100-01-01')`;
  const material = { ...candidate, sourceId, via: "fetch" as const };
  const { articleId } = await upsertMaterial(material);
  await queueProcessing(articleId);
  const jobNames = async () => (await sql<{ name: string }[]>`SELECT name FROM pgboss.job WHERE data->>'articleId'=${articleId}`).map((row) => row.name);
  assert.deepEqual(await jobNames(), [QUEUES.extractBody]);
  assert.equal((await analyzeArticle(articleId))!.needsBody, true);
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id=${articleId}`).length, 0);
  const pagesBefore = pageRequests;
  assert.equal(await extractArticleBody(articleId, false), "unconfirmed");
  assert.equal(pageRequests, pagesBefore + 1);
  const a = (await loadAnalyzeInput(articleId))!;
  assert.deepEqual([a.bodyStatus, a.excerpt, a.bodyText], ["unconfirmed", SHORT, null]);
  await queueProcessing(articleId);
  assert.equal((await jobNames()).filter((name) => name === QUEUES.extractBody).length, 1);
  assert.ok((await jobNames()).includes(QUEUES.analyze));

  const requests: Array<{ step: string; user: string }> = [];
  let label: "UNKNOWN" | "BLOCK" = "UNKNOWN";
  const provider = await stub((_hit, req) => {
    const messages = JSON.parse(req.body).messages as Array<{ role: string; content: unknown }>;
    const system = messages[0]!.role === "system" ? String(messages[0]!.content) : "";
    const user = String(messages.at(-1)!.content);
    const step = system.includes("宽召回的财经相关性预筛") ? "prefilter" : system.includes("事件注意力评分器") ? "score"
      : system.includes("内容理解编辑") ? "understand" : system.includes("资料结构化助手") ? "structure" : "unexpected";
    requests.push({ step, user });
    assert.notEqual(step, "unexpected");
    const content = step === "prefilter" ? { label, reason: "本地假模型固定回答" }
      : step === "score" ? { attentionScore: 80 }
      : step === "structure" ? { category: "company", tags: ["公司公告", "订单合同"], subjects: [], fact: null }
      : { itemType: "company_event", authorRole: "principal", tags: ["公司公告", "订单合同"], editorialJudgment: "虚构合同提供金额与期限。", titleZh: "虚构甲公司签署2亿元储能设备合同", summaryZh: SHORT };
    return { id: `short-stub-${requests.length}`, model: "stub", choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
  });
  for (const name of ["DASHSCOPE", "ZHIPU", "DEEPSEEK"]) {
    process.env[`${name}_BASE_URL`] = `${provider.url}/v1`;
    process.env[`${name}_API_KEY`] = "test-key";
  }
  try {
    const result = (await analyzeArticle(articleId))!;
    assert.deepEqual([result.needsBody ?? false, result.output!.relevance, result.output!.selected], [false, "pass", true]);
    assert.deepEqual(requests.map((r) => r.step).sort(), ["prefilter", "score", "score", "structure", "understand"]);
    for (const request of requests) assert.ok(request.user.includes(SHORT), request.step);
    assert.equal(result.receiptIds.length, 5, "fake provider still passes through receipts");
    const hits = provider.hits();
    assert.equal((await analyzeArticle(articleId))!.reused, true);
    assert.equal(provider.hits(), hits, "unchanged analysis reuses receipts");
    const duplicate = await upsertMaterial(material);
    assert.deepEqual([duplicate.articleId, duplicate.created, duplicate.revised], [articleId, false, false]);
    await queueProcessing(articleId);
    assert.equal((await jobNames()).filter((name) => name === QUEUES.extractBody).length, 1);
    assert.equal(pageRequests, pagesBefore + 1, "failed extraction is not repeated by analysis or unchanged recollection");
    assert.equal((await loadAnalyzeInput(articleId))!.bodyStatus, "unconfirmed");

    // Explicit BLOCK remains effective when real material exists; shortness does not bypass prefilter.
    label = "BLOCK";
    const before = requests.length;
    const blocked = await runAnalysis({ ...a, id: `short-block-${T}`, title: "虚构生活促销", excerpt: "虚构家居生活课程广告，不含财经事实。" }, { stages: "selection" });
    assert.deepEqual([blocked.prefilter.label, blocked.scores], ["BLOCK", null]);
    assert.deepEqual(requests.slice(before).map((r) => r.step), ["prefilter"]);
  } finally {
    await provider.close();
  }
});
