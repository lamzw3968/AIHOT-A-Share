// Theme attention is separate from occurrence/story grouping and editorial selection.
// No model calls: the worker snapshots locally available, eligible material every five minutes.
import { HOT_TOPICS, HOT_TOPIC_RULES } from "@aihot/industry/hot-topics";
import type { TopicCatalyst, TopicHotEntry, TopicHotResponse } from "@aihot/contracts/topic-hot";
import { sql, type Db } from "../db.ts";
import { listedCondition, pendingReleaseCondition } from "../publication/scope.ts";
import { matchTopicSignals, platformOf } from "../sources/topic-signals.ts";

const HOUR = 3_600_000;
export const TOPIC_INPUT_LIMIT = 10_000;
export const TOPIC_REFRESH_MS = 5 * 60_000;
const definitions = new Map(HOT_TOPICS.map((t) => [t.slug, t]));

export interface TopicMaterial {
  id: string; title: string; summary: string | null; body: string | null; tags: string[];
  url: string; observedAt: Date; sourceId: string; sourceName: string; sourceTags: string[];
  group: string; sourceSince: Date; discussion: boolean; publicNow: boolean; firstParty: boolean;
  storyPublicId: string | null;
}
export interface TopicSource {
  id: string; name: string; discussion: boolean; since: Date;
  scheduled: boolean; lastOk: Date | null; graceMs: number;
}

/** Public links cannot carry basic-auth credentials or private collector tokens. */
export function safeTopicUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    if ([...url.searchParams.keys()].some((k) => /^(?:access[_-]?token|api[_-]?key|token|secret|password|auth|authorization)$/i.test(k))) return null;
    return url.href;
  } catch { return null; }
}

export async function topicSources(db: Db = sql): Promise<TopicSource[]> {
  const rows = await db<{ id: string; name: string; participation_mode: string; created_at: Date;
    enabled: boolean; kind: string; last_ok_at: Date | null; interval_minutes: number }[]>`
    SELECT id,name,participation_mode,created_at,enabled,kind,last_ok_at,interval_minutes
    FROM sources WHERE participation_mode <> 'isolated' ORDER BY id`;
  return rows.map((s) => ({ id: s.id, name: s.name, discussion: s.participation_mode === "hot_signal", since: s.created_at,
    scheduled: s.enabled && ["rss", "web_list", "json_list", "x_search", "mp_account"].includes(s.kind),
    lastOk: s.last_ok_at, graceMs: Math.max(90, s.interval_minutes * 3) * 60_000 }));
}

/** One bounded query. Keep gated IDs in snapshots so reads can open them at their release deadline. */
export async function topicMaterials(at: Date, publicAt = at, ids?: string[], db: Db = sql): Promise<TopicMaterial[]> {
  const from = new Date(at.getTime() - (HOT_TOPIC_RULES.windowHours + HOT_TOPIC_RULES.compareHours) * HOUR);
  const rows = await db<{ id: string; title: string; summary: string | null; body: string | null; tags: string[];
    url: string; observed_at: Date; source_id: string; source_name: string; source_tags: string[];
    participant_key: string; source_since: Date; discussion: boolean; public_now: boolean; first_party: boolean; story_public_id: string | null }[]>`
    SELECT a.id,
      CASE WHEN s.participation_mode='editorial' THEN p.title ELSE a.title END AS title,
      CASE WHEN s.participation_mode='editorial' THEN p.summary ELSE NULL END AS summary,
      CASE WHEN s.participation_mode='hot_signal' THEN left(coalesce(a.body_text,a.excerpt,''),2000) ELSE NULL END AS body,
      coalesce(p.tags,'{}'::text[]) AS tags,
      CASE WHEN s.participation_mode='editorial' THEN p.url ELSE a.url END AS url,
      coalesce(a.published_at,a.discovered_at) AS observed_at,
      s.id AS source_id,s.name AS source_name,s.tags AS source_tags,s.created_at AS source_since,
      CASE WHEN s.signal_group_id IS NOT NULL THEN 'group:'||s.signal_group_id
           WHEN s.owner_entity_id IS NOT NULL THEN 'owner:'||s.owner_entity_id ELSE 'source:'||s.id END AS participant_key,
      s.participation_mode='hot_signal' AS discussion,
      CASE WHEN s.participation_mode='editorial' THEN (${listedCondition(publicAt)}) ELSE true END AS public_now,
      s.first_party,st.public_id::text AS story_public_id
    FROM articles a JOIN sources s ON s.id=a.source_id LEFT JOIN publications p ON p.article_id=a.id
    LEFT JOIN stories st ON st.id=p.story_id AND st.merged_into IS NULL
    WHERE NOT a.backfill AND coalesce(a.published_at,a.discovered_at)>${from}
      AND coalesce(a.published_at,a.discovered_at)<=${at}
      AND s.participation_mode <> 'isolated'
      AND (s.participation_mode='hot_signal' AND coalesce(p.visibility,'public')='public'
           AND a.processing_state <> 'blocked'
        OR s.participation_mode='editorial' AND p.visibility='public' AND p.eligible)
      ${ids ? db`AND a.id=ANY(${ids}::text[])` : db``}
    ORDER BY coalesce(a.published_at,a.discovered_at) DESC,a.id LIMIT ${TOPIC_INPUT_LIMIT + 1}`;
  return rows.map((r) => ({ id: r.id, title: r.title, summary: r.summary, body: r.body, tags: r.tags, url: r.url,
    observedAt: r.observed_at, sourceId: r.source_id, sourceName: r.source_name, sourceTags: r.source_tags,
    group: r.participant_key, sourceSince: r.source_since, discussion: r.discussion, publicNow: r.public_now,
    firstParty: r.first_party, storyPublicId: r.story_public_id }));
}

export async function topicReleaseDeadline(ids: string[], now: Date, db: Db = sql): Promise<Date | null> {
  if (!ids.length) return null;
  const [r] = await db<{ at: Date | null }[]>`SELECT min(p.visible_after) AS at FROM publications p
    JOIN sources s ON s.id=p.source_id WHERE p.article_id=ANY(${ids}::text[]) AND p.eligible
      AND s.participation_mode='editorial' AND ${pendingReleaseCondition(now)}`;
  return r?.at ?? null;
}

// Only explicit denial of a circulating claim is a clarification badge. Approval delay, a normal
// contract termination, and "澄清：属实" are not classified as a debunking by keyword alone.
export function isTopicClarification(m: Pick<TopicMaterial, "title" | "summary" | "firstParty">): boolean {
  return m.firstParty && /(?:澄清|辟谣|回应|否认)/u.test(m.title)
    && /(?:不属实|并不属实|不实|并无|不存在|未签署|未获得|未获|否认|谣言)/u.test(`${m.title} ${m.summary ?? ""}`);
}

/** Pure calculation; counts material and independent configured source groups, never people. */
export function buildTopicHotBoard(materials: TopicMaterial[], sources: TopicSource[], at: Date,
  options: { truncated?: boolean; now?: Date; ruleVersion?: string } = {}): TopicHotResponse {
  const now = options.now ?? at;
  const end = at.getTime();
  const start = Math.max(end - HOT_TOPIC_RULES.windowHours * HOUR, now.getTime() - HOT_TOPIC_RULES.windowHours * HOUR);
  const previous = end - HOT_TOPIC_RULES.compareHours * HOUR;
  const previousStart = previous - HOT_TOPIC_RULES.windowHours * HOUR;
  const behind = sources.filter((s) => s.scheduled && (!s.lastOk || s.lastOk.getTime() < now.getTime() - s.graceMs));
  const behindIds = new Set(behind.map((s) => s.id));
  const stale = now.getTime() - end >= TOPIC_REFRESH_MS * 3;
  const byTopic = new Map<string, { name: string; candidate: boolean; members: TopicMaterial[] }>();
  for (const m of new Map(materials.map((m) => [m.id, m])).values()) {
    if (!m.publicNow || m.observedAt.getTime() > end || m.observedAt.getTime() <= previousStart || !safeTopicUrl(m.url)) continue;
    const matches = matchTopicSignals({ title: m.title, bodyText: m.discussion ? m.body : m.summary,
      tags: m.discussion ? [] : m.tags, sourceTags: m.sourceTags, discussion: m.discussion });
    for (const match of matches) {
      const bucket: { name: string; candidate: boolean; members: TopicMaterial[] } = byTopic.get(match.slug)
        ?? { name: match.name, candidate: match.candidate, members: [] };
      bucket.members.push(m); byTopic.set(match.slug, bucket);
    }
  }
  const entries: TopicHotEntry[] = [];
  const relevant = new Map<string, TopicMaterial>();
  for (const [slug, bucket] of byTopic) {
    const current = bucket.members.filter((m) => m.observedAt.getTime() > start);
    if (!current.length) continue;
    for (const m of current) relevant.set(m.id, m);
    const groups = new Map<string, TopicMaterial[]>();
    for (const m of bucket.members) {
      const list = groups.get(m.group) ?? [];
      list.push(m); groups.set(m.group, list);
    }
    let heat = 0, oldHeat = 0, groupCount = 0, newGroups = 0;
    let comparable = !stale && !options.truncated;
    for (const list of groups.values()) {
      const currentList = list.filter((m) => m.observedAt.getTime() > start);
      const old = list.filter((m) => m.observedAt.getTime() <= previous && m.observedAt.getTime() > previousStart);
      const latest = (a: TopicMaterial[]) => Math.max(...a.map((m) => m.observedAt.getTime()));
      if (currentList.length) { groupCount++; heat += 0.5 ** ((end - latest(currentList)) / HOUR / HOT_TOPIC_RULES.halfLifeHours); }
      if (old.length) oldHeat += 0.5 ** ((previous - latest(old)) / HOUR / HOT_TOPIC_RULES.halfLifeHours);
      if (currentList.length && !old.length) newGroups++;
      // A widened collection cohort or overdue source cannot establish organic growth.
      if (list.some((m) => behindIds.has(m.sourceId) || m.sourceSince.getTime() > previousStart)) comparable = false;
    }
    const pct = comparable && oldHeat > 0 ? Math.round((heat - oldHeat) / oldHeat * 1000) / 10 : null;
    const reports = current.filter((m) => !m.discussion).sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime() || a.id.localeCompare(b.id));
    const catalysts: TopicCatalyst[] = reports.slice(0, 20).map((m) => ({ itemId: m.id, title: m.title,
      summary: m.summary, publishedAt: m.observedAt.toISOString(), sourceName: m.sourceName,
      firstParty: m.firstParty, url: safeTopicUrl(m.url)!, storyPublicId: m.storyPublicId, clarification: isTopicClarification(m) }));
    const clarified = reports.some(isTopicClarification);
    const positiveOfficial = reports.some((m) => m.firstParty && !isTopicClarification(m));
    const platforms = [...new Set(current.map((m) => platformOf(m.url)).filter((p): p is string => !!p))].sort();
    const discussion = current.filter((m) => m.discussion);
    entries.push({ rank: 0, topic: { slug, name: bucket.name, candidate: bucket.candidate,
      definition: bucket.candidate ? "互联网讨论候选题材，名称来自材料话题标签，尚未确认事实或板块影响。" : `与${definitions.get(slug)?.name ?? bucket.name}相关的讨论和报道；题材关联不代表板块已经受到影响。` },
      heat: Math.round(heat * 100) / 10, trend: !comparable ? "unknown" : oldHeat <= 0 ? "new" : pct! > 10 ? "up" : pct! < -10 ? "down" : "flat",
      trendPct: pct, sourceGroupCount: groupCount, discussionGroupCount: new Set(discussion.map((m) => m.group)).size,
      discussionCount: discussion.length, recentDiscussionCount: discussion.filter((m) => m.observedAt.getTime() > previous).length,
      newSourceGroupCount: newGroups, platformCount: platforms.length, platformNames: platforms,
      sourceNames: [...new Set(current.map((m) => m.sourceName))].sort(),
      storyCount: new Set(reports.map((m) => m.storyPublicId).filter(Boolean)).size, reportCount: reports.length,
      evidenceStatus: clarified ? positiveOfficial ? "mixed" : "clarified" : reports.some((m) => m.firstParty) ? "first_party" : reports.length ? "reported" : "unverified",
      latestCatalyst: catalysts[0] ?? null, catalysts,
      firstSeenAt: new Date(Math.min(...current.map((m) => m.observedAt.getTime()))).toISOString(),
      latestAt: new Date(Math.max(...current.map((m) => m.observedAt.getTime()))).toISOString() });
  }
  entries.sort((a, b) => b.heat - a.heat || b.discussionGroupCount - a.discussionGroupCount || b.latestAt.localeCompare(a.latestAt) || a.topic.slug.localeCompare(b.topic.slug));
  entries.forEach((e, i) => { e.rank = i + 1; });
  const visible = [...relevant.values()];
  return { computedAt: at.toISOString(), ruleVersion: options.ruleVersion ?? HOT_TOPIC_RULES.ruleVersion,
    windowHours: HOT_TOPIC_RULES.windowHours, compareHours: HOT_TOPIC_RULES.compareHours, halfLifeHours: HOT_TOPIC_RULES.halfLifeHours,
    topCount: HOT_TOPIC_RULES.topCount, refreshAt: new Date(end + TOPIC_REFRESH_MS).toISOString(), stale, entries,
    coverage: { countBasis: "source-groups", sourceCount: new Set(visible.map((m) => m.sourceId)).size,
      discussionSourceCount: new Set(visible.filter((m) => m.discussion).map((m) => m.sourceId)).size,
      platformCount: new Set(visible.map((m) => platformOf(m.url)).filter(Boolean)).size,
      behindSourceCount: behind.length, behindSourceNames: behind.map((s) => s.name), inputCount: materials.length,
      truncated: !!options.truncated, interactionMetricsAvailable: false }, marketDataAvailable: false };
}

export async function computeTopicHotRanking(at = new Date()): Promise<{ id: number; entries: number }> {
  const [all, sources] = await Promise.all([topicMaterials(at), topicSources()]);
  const rows = all.slice(0, TOPIC_INPUT_LIMIT);
  const board = buildTopicHotBoard(rows, sources, at, { truncated: all.length > TOPIC_INPUT_LIMIT });
  const [saved] = await sql<{ id: number }[]>`INSERT INTO topic_hot_rankings(computed_at,rule_version,article_ids,board)
    VALUES (${at},${board.ruleVersion},${rows.map((m) => m.id)},${sql.json(board as never)}) RETURNING id`;
  // Keep at most one day's five-minute snapshots, restricted to this derived table.
  await sql`DELETE FROM topic_hot_rankings WHERE id NOT IN
    (SELECT id FROM topic_hot_rankings ORDER BY computed_at DESC,id DESC LIMIT 288)`;
  return { id: saved!.id, entries: board.entries.length };
}
