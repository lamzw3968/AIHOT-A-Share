// Finance business configuration and prompt contracts; fixtures do not establish real model quality.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { SITE, subjectAfter, withSubject } from "@aihot/industry/site";
import { FEATURES } from "@aihot/industry/features";
import { SELECTION } from "@aihot/industry/selection";
import { HOT_TOPICS, HOT_TOPIC_RULES } from "@aihot/industry/hot-topics";
import { CATEGORIES, CATEGORY_BY_ITEM_TYPE, CATEGORY_TAGS, ENTITIES, ENTITY_TAGS, IDENTITY_LEXICON, ITEM_TYPES, PUBLISHER_DOMAINS, TOPIC_TAGS } from "@aihot/industry/taxonomy";
import { promptText } from "@aihot/backend/editorial/prompts";
import { enforceIdentity, matchEntityIds } from "@aihot/backend/editorial/writing";
import { normalizeTags } from "@aihot/backend/editorial/vocabulary";
import { PairSchema } from "@aihot/backend/events/relate";
import { parseRelationGoldJsonl } from "../scripts/eval-relations-core.ts";

const readIndustry = (file: string) => readFileSync(new URL(`../industry/${file}`, import.meta.url), "utf8");
const prompt = (name: string) => readIndustry(`prompts/${name}.md`);
const expectedBindings: Record<string, string[]> = {
  "group-pair": [
    ">group-definitions"
  ],
  "group-signal": [],
  "safety": [],
  "rules-self-contained-title": [],
  "translate-post": [],
  "prefilter": [
    "siteName"
  ],
  "report-period": [
    "kindName",
    "overviewLength",
    "siteName",
    "siteName"
  ],
  "summarize-article": [
    ">rules-answer-first-summary",
    ">rules-anti-hallucination",
    ">rules-domain",
    ">rules-self-contained-title",
    "body",
    "identity",
    "publishedDate",
    "sourceName",
    "title",
    "today"
  ],
  "story-digest": [
    "siteName"
  ],
  "report-daily-lead": [
    "siteName"
  ],
  "group-batch": [
    ">group-definitions",
    ">group-method"
  ],
  "understand": [
    ">content-understanding",
    ">rules-answer-first-summary",
    ">rules-anti-hallucination",
    ">rules-domain",
    ">rules-self-contained-title"
  ],
  "structure": [
    ">safety",
    "categoryCount",
    "categoryGuide",
    "categoryTags",
    "entities",
    "entityTags",
    "siteName",
    "topicTags"
  ],
  "summarize-long-post-quoted": [
    "quotedLabel",
    "quotedText"
  ],
  "rules-domain": [],
  "summarize-article-empty": [],
  "rules-anti-hallucination": [],
  "group-method": [],
  "group-definitions": [],
  "selection-score": [
    "siteName",
    "siteName",
    "siteName",
    "siteName"
  ],
  "rules-answer-first-summary": [],
  "translate-body": [],
  "summarize-short-post": [
    ">rules-anti-hallucination",
    ">rules-domain",
    ">rules-self-contained-title",
    "identity",
    "post",
    "sourceName"
  ],
  "identity-context": [
    "facts"
  ],
  "summarize-short-post-quoted": [
    "quotedLabel",
    "quotedText"
  ],
  "summarize-long-post": [
    ">rules-answer-first-summary",
    ">rules-anti-hallucination",
    ">rules-domain",
    ">rules-self-contained-title",
    "identity",
    "post",
    "sourceName"
  ],
  "content-understanding": [
    "siteName"
  ]
};
const expectedTypes = ["market_move", "company_event", "industry_event", "policy_event", "capital_event", "macro_event", "opinion_analysis"];
const expectedCategoryTags = ["市场异动", "公司动态", "公司公告", "业绩", "产业趋势", "政策监管", "资本运作", "宏观数据", "机构观点", "其他"];
const originalTopicTags = ["半导体", "AI算力", "机器人", "创新药", "新能源", "汽车", "消费", "房地产", "金融", "军工", "有色", "化工", "能源", "光伏", "储能", "港股", "IPO", "并购重组", "增持回购", "业绩增长", "业绩下滑", "订单合同", "涨价", "降价"];
const fineTopics = [
  ["optical-communications", "光通信", "ai-compute"], ["liquid-cooling", "液冷", "ai-compute"],
  ["semiconductor-equipment", "半导体设备", "semiconductors"], ["semiconductor-materials", "半导体材料", "semiconductors"], ["advanced-packaging", "先进封装", "semiconductors"],
  ["robot-actuators", "机器人执行器", "robotics"], ["robot-sensors", "机器人传感器", "robotics"],
  ["drug-clinical", "创新药临床", "innovative-drugs"], ["drug-approval", "创新药审批", "innovative-drugs"], ["drug-licensing", "创新药授权", "innovative-drugs"],
] as const;
const expectedTopicTags = [...originalTopicTags, ...fineTopics.map(topic => topic[1])];
const expectedEntities = ["csrc", "sse", "szse", "bse", "pboc", "nbs", "hkex"];
const expectedEntityNames = ["中国证监会", "上交所", "深交所", "北交所", "中国人民银行", "国家统计局", "港交所"];
const expectedFieldSlugs = ["semiconductors", "ai-compute", "robotics", "innovative-drugs", "new-energy", "auto", "consumption", "real-estate", "financial-sector", "defense", "nonferrous-metals", "chemicals", "energy", "solar", "energy-storage", "hk-stocks", "ipo", "ma", "buyback-increase", "earnings-growth", "earnings-decline", "orders-contracts", "price-rise", "price-fall"];
const expectedGenreSlugs = ["market-moves", "company-updates", "company-announcements", "earnings", "industry-trends", "policy-regulation", "capital-actions", "macro-data", "institutional-opinions", "other-news"];

test("finance V1 keeps the brand, six categories, seven types, gates and disabled AI features", () => {
  assert.deepEqual([SITE.name, SITE.mcpPrefix, SITE.subject], ["MyHOT", "myhot", "A股"]);
  assert.equal(withSubject("日报"), "A股日报");
  assert.equal(subjectAfter("往期", "日报"), "往期 A股日报");
  assert.deepEqual(CATEGORIES.map(c => [c.key, c.label, c.section]), [
    ["market", "市场", "市场动态"], ["company", "公司", "公司动态"], ["industry", "行业", "产业趋势"],
    ["policy", "政策", "政策与监管"], ["capital", "资本", "资本运作"], ["macro", "宏观", "宏观经济"],
  ]);
  assert.deepEqual(ITEM_TYPES, expectedTypes);
  assert.deepEqual(CATEGORY_TAGS, expectedCategoryTags);
  assert.deepEqual(TOPIC_TAGS, expectedTopicTags);
  assert.deepEqual(Object.keys(ENTITIES), expectedEntities);
  assert.deepEqual(ENTITY_TAGS, expectedEntities.map(id => ENTITIES[id]!.displayTag));
  assert.deepEqual(SELECTION.thresholds, { T1: 60, T1_5: 65, T2: 76 });
  assert.equal(SELECTION.understandFloor, 50);
  assert.deepEqual(FEATURES, { leaderboard: false, codexResetMonitor: false });
  assert.deepEqual(PUBLISHER_DOMAINS, []);
});

test("finance score weights reuse the approved factual and opinion vectors without changing score output", () => {
  const score = prompt("selection-score");
  const rows = [...score.matchAll(/^\| (\w+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \|$/gm)];
  assert.deepEqual(rows.map(row => row[1]), expectedTypes);
  for (const row of rows) {
    const weights = row.slice(2).map(Number);
    assert.deepEqual(weights, row[1] === "opinion_analysis" ? [1, 3, 1, 4, 1] : [3, 1, 2, 4, 0]);
    assert.equal(weights.reduce((a, b) => a + b, 0), 10);
  }
  assert.match(score, /0–10 整数分/);
  assert.match(score, /只能包含 `attentionScore`/);
  assert.ok(score.includes('{"attentionScore": 0}'));
  assert.doesNotMatch(score, /model_release|product_launch|tool_or_prompt|research_paper|tutorial_explainer/);
});

test("the full 27-prompt pack preserves include/value bindings and renders without unresolved tokens", () => {
  const files = readdirSync(new URL("../industry/prompts/", import.meta.url)).filter(file => file.endsWith(".md")).map(file => file.slice(0, -3)).sort();
  assert.deepEqual(files, Object.keys(expectedBindings).sort());
  assert.equal(files.length, 27);
  const values = Object.fromEntries([...new Set(Object.values(expectedBindings).flat().filter(token => !token.startsWith(">")))].map(token => [token, token === "siteName" ? SITE.name : "fixture"]));
  for (const name of files) {
    const tokens = [...prompt(name).matchAll(/\{\{(>\s*)?([A-Za-z][\w.-]*)\s*\}\}/g)].map(m => (m[1] ? ">" : "") + m[2]).sort();
    assert.deepEqual(tokens, expectedBindings[name], name);
    const rendered = promptText(name, values);
    assert.ok(rendered.length > 20, name);
    assert.doesNotMatch(rendered, /\{\{/, name);
  }
  const understand = promptText("understand");
  for (const type of expectedTypes) assert.ok(understand.includes(type), type);
  for (const tag of [...expectedCategoryTags, ...expectedTopicTags, ...ENTITY_TAGS]) assert.ok(understand.includes(tag), tag);
  assert.match(understand, /六个字段/);
  assert.match(understand, /只有原文明示机构身份/);
  assert.match(prompt("prefilter"), /UNKNOWN不据此直接拦截/);
  assert.doesNotMatch(prompt("prefilter"), /UNKNOWN等待补材料/);
});

test("all 51 finance topics put fields first and preserve every original finance URL and mapping", () => {
  const catalog = JSON.parse(readIndustry("topics.json")) as { groups: Array<{ key: string; name: string }>; topics: Array<{ slug: string; name: string; group: string; tags: string[]; entityId?: string; related: string[]; definition: string }> };
  assert.deepEqual(catalog.groups.map(group => [group.key, group.name]), [
    ["field", "产业与关注主题"], ["company", "机构与市场组织"], ["genre", "资讯类型"],
  ]);
  assert.deepEqual(catalog.topics.map(topic => [topic.slug, topic.name, topic.group]), [
    ...fineTopics.map(([slug, name]) => [`finance-${slug}`, name, "field"]),
    ...expectedFieldSlugs.map((slug, index) => [`finance-${slug}`, originalTopicTags[index], "field"]),
    ...expectedEntities.map((slug, index) => [`finance-${slug}`, expectedEntityNames[index], "company"]),
    ...expectedGenreSlugs.map((slug, index) => [`finance-${slug}`, expectedCategoryTags[index], "genre"]),
  ]);
  assert.equal(catalog.topics.length, 51);
  assert.equal(new Set(catalog.topics.map(topic => topic.slug)).size, 51);
  const oldMapping = [
    ...expectedEntities.map((slug, index) => [`finance-${slug}`, expectedEntityNames[index], "company"]),
    ...expectedFieldSlugs.map((slug, index) => [`finance-${slug}`, originalTopicTags[index], "field"]),
    ...expectedGenreSlugs.map((slug, index) => [`finance-${slug}`, expectedCategoryTags[index], "genre"]),
  ];
  assert.equal(oldMapping.length, 41);
  assert.deepEqual(oldMapping.map(([slug]) => {
    const topic = catalog.topics.find(topic => topic.slug === slug)!;
    return [topic.slug, topic.name, topic.group];
  }), oldMapping);
  for (const topic of catalog.topics) {
    assert.match(topic.slug, /^finance-[a-z0-9-]+$/);
    assert.ok(topic.definition.length > 15);
    assert.deepEqual(topic.related, []);
    if (topic.entityId) assert.deepEqual(topic.tags, [ENTITIES[topic.entityId]!.displayTag, `entity:${topic.entityId}`]);
  }
  assert.deepEqual(catalog.topics.filter(topic => topic.group === "company").map(topic => topic.entityId), expectedEntities);
  assert.deepEqual(catalog.topics.filter(topic => topic.group === "field").map(topic => topic.tags[0]), [...fineTopics.map(topic => topic[1]), ...originalTopicTags]);
  assert.deepEqual(catalog.topics.filter(topic => topic.group === "genre").map(topic => topic.tags[0]), expectedCategoryTags);
  assert.ok(catalog.topics.some(topic => topic.slug === "finance-company-updates"));
});

test("topic discussion vocabulary covers all 34 fields without inventing market or security data", () => {
  assert.deepEqual(HOT_TOPIC_RULES, { ruleVersion: "topic-news-v1-48h", windowHours: 48, halfLifeHours: 24, compareHours: 6, topCount: 5 });
  const catalog = JSON.parse(readIndustry("topics.json")) as { topics: Array<{ slug: string; name: string; group: string }> };
  const fields = catalog.topics.filter(topic => topic.group === "field");
  assert.equal(HOT_TOPICS.length, 34);
  assert.deepEqual(HOT_TOPICS.map(topic => [topic.slug, topic.name]), fields.map(topic => [topic.slug, topic.name]));
  assert.deepEqual(HOT_TOPICS.filter(topic => topic.parentSlug).map(topic => [topic.slug, topic.name, topic.parentSlug]),
    fineTopics.map(([slug, name, parent]) => [`finance-${slug}`, name, `finance-${parent}`]));
  for (const topic of HOT_TOPICS) {
    assert.deepEqual(topic.tags, [topic.name]);
    assert.ok(TOPIC_TAGS.includes(topic.name as typeof TOPIC_TAGS[number]));
    assert.ok(topic.keywords.length > 0);
    for (const keyword of [...topic.keywords, ...topic.aliases]) assert.ok(keyword.trim().length >= 2);
    for (const alias of topic.aliases) assert.deepEqual(normalizeTags([alias]), ["其他", topic.name]);
    if (topic.parentSlug) assert.ok(HOT_TOPICS.some(parent => parent.slug === topic.parentSlug && !parent.parentSlug));
  }
  const config = readIndustry("hot-topics.ts");
  assert.match(config, /不确认事实、证券映射或行情表现/);
  assert.match(config, /不重复计入其父主题/);
});

test("catalyst prompts keep evidence separate from discussion and retain wide recall and event boundaries", () => {
  assert.match(prompt("selection-score"), /互联网讨论热度与事实证据是不同信息/);
  assert.match(prompt("selection-score"), /例行宏观数据复述/);
  assert.match(prompt("selection-score"), /重大宏观变化和有证据的研究仍正常评价/);
  assert.match(prompt("prefilter"), /UNKNOWN不据此直接拦截/);
  assert.match(prompt("prefilter"), /不因未进入题材榜、讨论不热或没有细分题材而BLOCK/);
  assert.match(prompt("group-definitions"), /同题材可以包含多个UNRELATED事实/);
  assert.match(prompt("group-signal"), /仅讨论宽泛题材、不能指向候选那次具体发生时返回UNRELATED/);
  assert.match(prompt("structure"), /主题相关性不是事实成立、股价反应或证券身份的证明/);
  assert.match(prompt("rules-domain"), /互联网讨论热度、产业关联证据和已观察市场反应分开表达/);
  assert.match(prompt("rules-anti-hallucination"), /关键词命中只表示题材相关性/);
  assert.match(prompt("content-understanding"), /不由题材猜受益股/);
  for (const report of ["report-daily-lead", "report-period"]) assert.match(prompt(report), /没有行情核验输入/);
});

test("company events default to company updates and a personal opinion is not labeled an institution", () => {
  assert.equal(CATEGORY_BY_ITEM_TYPE.company_event, "公司动态");
  assert.equal(CATEGORY_BY_ITEM_TYPE.opinion_analysis, "其他");
  assert.deepEqual(normalizeTags(["订单", "储能", "不存在"], { fallbackCategory: CATEGORY_BY_ITEM_TYPE.company_event }), ["公司动态", "订单合同", "储能"]);
  assert.deepEqual(normalizeTags(["财报", "业绩增长"]), ["业绩", "业绩增长"]);
  assert.deepEqual(normalizeTags(["市场异动", "Agent", "MCP/工具调用"]), ["市场异动"]);
});

test("identity protection rejects invented institutions and keeps unknown company names intact", () => {
  assert.deepEqual(IDENTITY_LEXICON.map(entity => entity.id), expectedEntities);
  const input = { title: "虚构甲公司签署2亿元订单", text: "虚构甲公司签署2亿元储能订单，合同待履行。", sourceKind: "rss" };
  const copy = { titleZh: input.title, summaryZh: input.text };
  const valid = enforceIdentity(input, copy);
  assert.deepEqual([valid.titleZh, valid.summaryZh, valid.identityGuard.outcome], [copy.titleZh, copy.summaryZh, "pass"]);
  const invented = enforceIdentity(input, { ...copy, titleZh: "中国证监会签署2亿元订单" });
  assert.equal(invented.identityGuard.outcome, "fallback");
  assert.equal(invented.titleZh, input.title);
  assert.deepEqual(matchEntityIds(["外国央行讨论政策，服务通过SSE发送，NBS只是缩写"]), []);
  assert.deepEqual(matchEntityIds(["Shanghai Stock Exchange updates trading rules"]), ["sse"]);
  assert.deepEqual(matchEntityIds(["香港证监会更新规则", "美国证监会发布声明", "证监会披露消息"]), []);
  assert.deepEqual(matchEntityIds(["中国证券监督管理委员会发布通知"]), ["csrc"]);
  assert.deepEqual(matchEntityIds(["中国证监会发布通知"]), ["csrc"]);
  assert.deepEqual(matchEntityIds(["CSRC announces rules"]), ["csrc"]);
  assert.ok(!ENTITIES.csrc!.aliases.includes("证监会"));
  assert.deepEqual(normalizeTags(["证监会", "香港证监会", "美国证监会"]), ["其他"]);
  assert.deepEqual(normalizeTags(["中国证券监督管理委员会"]), ["其他", "中国证监会"]);
  for (const regulator of ["香港证监会", "美国证监会"]) {
    const foreign = { title: `${regulator}更新规则`, text: `${regulator}披露规则调整。`, sourceKind: "rss" };
    const faithful = enforceIdentity(foreign, { titleZh: foreign.title, summaryZh: foreign.text });
    assert.equal(faithful.identityGuard.outcome, "pass", regulator);
    const misattributed = enforceIdentity(foreign, { titleZh: "中国证监会更新规则", summaryZh: foreign.text });
    assert.equal(misattributed.identityGuard.outcome, "fallback", regulator);
    assert.equal(misattributed.titleZh, foreign.title, regulator);
  }
  for (const regulator of ["中国证券监督管理委员会", "中国证监会", "CSRC"]) {
    const chinese = { title: `${regulator}发布通知`, text: `${regulator}披露规则调整。`, sourceKind: "rss" };
    assert.equal(enforceIdentity(chinese, { titleZh: "中国证监会发布通知", summaryZh: "中国证监会披露规则调整。" }).identityGuard.outcome, "pass", regulator);
  }
});

test("fictional selection and relation Gold samples retain evaluation formats without claiming calibration", () => {
  const selection = readIndustry("gold.example.jsonl").trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(selection.length, 2);
  assert.deepEqual(selection.map(row => row.gold.decision), ["select", "reject"]);
  for (const row of selection) {
    assert.deepEqual(Object.keys(row).sort(), ["caseId", "gold", "material", "samplingContext", "sourceFacts"]);
    assert.deepEqual(Object.keys(row.material).sort(), ["bodyOriginal", "bodyZh", "originalTitle", "publishedAt", "sourceName", "title"]);
    assert.match(row.material.title, /虚构格式样本/);
    assert.match(row.material.bodyZh, /虚构格式样本/);
    assert.equal(row.samplingContext.benchmarkSplit, "development");
  }
  const relations = parseRelationGoldJsonl(readIndustry("relation-gold.example.jsonl"));
  assert.equal(relations.length, 4);
  assert.deepEqual(relations.map(row => row.gold.relation), ["SAME_OCCURRENCE", "SAME_STORY", "UNRELATED", "ROUNDUP"]);
  for (const row of relations) {
    assert.match(row.a.title, /虚构格式样本/);
    assert.match(row.b.title, /虚构格式样本/);
    assert.ok(PairSchema.safeParse({ a: row.a.title, b: row.b.title, relation: row.gold.relation, difference: "格式测试", confidence: 0.9 }).success);
  }
});

test("financial grouping, story and report prompts keep relation and citation output contracts", () => {
  const definitions = prompt("group-definitions");
  for (const relation of ["SAME_OCCURRENCE", "SAME_STORY", "UNRELATED", "ROUNDUP"]) assert.ok(definitions.includes(relation));
  for (const boundary of ["不同公司", "不同报告期", "不同交易日", "阶段"]) assert.ok(definitions.includes(boundary));
  const output = (name: string) => JSON.parse(prompt(name).match(/只输出 JSON：(\{[^\r\n]+\})/)![1]!);
  assert.deepEqual(Object.keys(output("story-digest")), ["title", "digest", "latest"]);
  assert.deepEqual(Object.keys(output("report-daily-lead")), ["title", "leadParagraph", "highlights"]);
  const period = output("report-period");
  assert.deepEqual(Object.keys(period), ["headline", "overview", "themes"]);
  assert.deepEqual(Object.keys(period.themes[0]), ["heading", "summary", "refs"]);
  assert.deepEqual(period.themes[0].refs, [1, 2]);
  assert.deepEqual(output("report-daily-lead").highlights, [1, 2, 3]);
  assert.match(prompt("report-period"), /不生成目标价、交易指令或确定涨跌结论/);
});
