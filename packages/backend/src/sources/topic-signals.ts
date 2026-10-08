// Text association only: a topic signal does not verify a fact, a price move or a shared event.
import { createHash } from "node:crypto";
import { HOT_TOPICS } from "@aihot/industry/hot-topics";

export interface TopicSignalInput {
  title: string;
  bodyText?: string | null;
  tags?: string[];
  sourceTags?: string[];
  discussion?: boolean;
}

export interface TopicSignalMatch {
  slug: string;
  name: string;
  candidate: boolean;
}

const TITLE_LIMIT = 1000;
const BODY_LIMIT = 20_000;
const TAG_LIMIT = 64;
const CANDIDATE_LIMIT = 8;
const MARKET_CONTEXT = /A\s*股|股票|股市|板块|资本市场|上市公司|证券市场/i;
const FINANCE_SOURCE = /^(?:财经(?:新闻|资讯|热点)?|金融|证券|A股|股票|股市|资本市场|上市公司|产业链)$/i;
const NOISE = /广告|荐股|VIP|会员|课程|加群|买入|卖出|目标价|必涨|必跌|抄底|梭哈|娱乐|八卦|明星|综艺|体育|足球|篮球|美食|旅游|穿搭|追剧|生活/i;
// A genuine industry discussion may mention tourism, consumption or quality of life. Reject
// explicit promotions for known themes rather than treating those ordinary nouns as advertising.
const DISCUSSION_PROMOTION = /VIP|荐股|加群|课程(?:广告|推广)|会员(?:推广|专享)|目标价|必涨|必跌|抄底|梭哈/i;
const INSTRUCTION = /(?:忽略|无视|覆盖).{0,16}(?:规则|指令|系统|提示)|(?:输出|返回|添加|生成|标记).{0,24}(?:slug|candidate|json|匹配结果)|(?:system|developer|assistant)\s*:|ignore.{0,24}(?:instructions?|rules)|(?:return|output).{0,24}(?:slug|candidate|json)/i;

const normalize = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

function cleanText(value: string, limit: number): string {
  return value.slice(0, limit).normalize("NFKC")
    .replace(/<(script|style|code)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, " ")
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, " ")
    .replace(/`[^`]*(?:`|$)/g, " ")
    .replace(/(?:https?:\/\/|www\.)[^\s<>"'）)\]】]+/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .split(/\r?\n/).filter(line => !INSTRUCTION.test(line)).join("\n");
}

function boundedTags(values: string[] | undefined): string[] {
  return (values ?? []).slice(0, TAG_LIMIT).map(value => normalize(value.slice(0, 96)));
}

function contains(text: string, term: string): boolean {
  const needle = normalize(term);
  if (needle.length < 2) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Latin abbreviations must not match inside unrelated words; Chinese words use the curated lexicon.
  const left = /^[a-z0-9]/i.test(needle) ? "(?:^|[^a-z0-9_])" : "";
  const right = /[a-z0-9]$/i.test(needle) ? "(?=$|[^a-z0-9_])" : "";
  return new RegExp(`${left}${escaped}${right}`, "i").test(text);
}

/** Deterministic discussion associations; candidates remain unverified and never change story grouping. */
export function matchTopicSignals(input: TopicSignalInput): TopicSignalMatch[] {
  const text = `${cleanText(input.title, TITLE_LIMIT)}\n${cleanText(input.bodyText ?? "", BODY_LIMIT)}`;
  // Source labels give context, not evidence that every article concerns that topic.
  if (input.discussion && DISCUSSION_PROMOTION.test(text)) return [];
  const tags = new Set(boundedTags(input.tags));
  const hashtags = Array.from(text.matchAll(/#([^#\n]{1,96})#/g), match => match[1].trim());
  const hashtagKeys = new Set(hashtags.map(normalize));
  const known = HOT_TOPICS.filter(topic => {
    const identities = [topic.name, ...topic.tags, ...topic.aliases].map(normalize);
    return identities.some(term => tags.has(term) || hashtagKeys.has(term))
      || [...topic.keywords, ...topic.aliases].some(term => contains(text, term));
  });
  const parents = new Set<string>();
  for (const topic of known) {
    let parent = topic.parentSlug;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      parents.add(parent);
      parent = HOT_TOPICS.find(item => item.slug === parent)?.parentSlug;
    }
  }
  const out: TopicSignalMatch[] = known.filter(topic => !parents.has(topic.slug))
    .map(topic => ({ slug: topic.slug, name: topic.name, candidate: false }));
  const sourceTags = boundedTags(input.sourceTags);
  const financeSource = sourceTags.some(tag => FINANCE_SOURCE.test(tag)
    || HOT_TOPICS.some(topic => [topic.name, ...topic.tags, ...topic.aliases].some(term => normalize(term) === tag)));
  if (!input.discussion || NOISE.test(text) || !(MARKET_CONTEXT.test(text) || known.length || financeSource)) return out;

  const identities = new Set(HOT_TOPICS.flatMap(topic => [topic.name, ...topic.tags, ...topic.aliases, ...topic.keywords].map(normalize)));
  const candidates = new Set<string>();
  for (const name of hashtags) {
    const key = normalize(name);
    if (key.length < 2 || key.length > 24 || !/[\p{Script=Han}a-z]/u.test(key)
      || !/^[\p{Script=Han}a-z0-9 +.-]+$/u.test(key) || NOISE.test(key)
      || FINANCE_SOURCE.test(key) || identities.has(key) || candidates.has(key)) continue;
    candidates.add(key);
    out.push({ slug: `signal-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`, name: name.normalize("NFKC").replace(/\s+/g, " "), candidate: true });
    if (candidates.size >= CANDIDATE_LIMIT) break;
  }
  return out;
}

const PLATFORMS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["xueqiu.com", ["xueqiu.com"]],
  ["eastmoney.com", ["eastmoney.com"]],
  ["cls.cn", ["cls.cn"]],
  ["stcn.com", ["stcn.com"]],
  ["cnstock.com", ["cnstock.com"]],
  ["cs.com.cn", ["cs.com.cn"]],
  ["10jqka.com.cn", ["10jqka.com.cn"]],
  ["sina.com.cn", ["sina.com.cn", "sina.cn"]],
  ["weibo.com", ["weibo.com", "weibo.cn"]],
  ["weixin.qq.com", ["weixin.qq.com"]],
  ["x.com", ["x.com", "twitter.com"]],
  ["youtube.com", ["youtube.com", "youtu.be"]],
  ["bilibili.com", ["bilibili.com", "b23.tv"]],
];

/** Host identity only; credentials, ports, paths and query strings never leave this function. */
export function platformOf(value: string): string | null {
  if (value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    if (!host) return null;
    if (host === "example.invalid" || host.endsWith(".example.invalid")) return "example.invalid";
    for (const [platform, domains] of PLATFORMS) {
      if (domains.some(domain => host === domain || host.endsWith(`.${domain}`))) return platform;
    }
    return host;
  } catch {
    return null;
  }
}
