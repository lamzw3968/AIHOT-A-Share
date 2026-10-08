// All theme ranking exits read here. Revalidate source roles, withdrawals and release gates live;
// never reuse saved titles or raw discussion bodies, and never enqueue work from a page read.
import { HOT_TOPIC_RULES } from "@aihot/industry/hot-topics";
import type { TopicHotDetail, TopicHotResponse } from "@aihot/contracts/topic-hot";
import { sql } from "../db.ts";
import { buildTopicHotBoard, safeTopicUrl, topicMaterials, topicSources, topicReleaseDeadline, TOPIC_REFRESH_MS } from "../events/topic-heat.ts";
import { matchTopicSignals } from "../sources/topic-signals.ts";

async function read(now: Date) {
  const [saved] = await sql<{ computed_at: Date; rule_version: string; article_ids: string[]; board: TopicHotResponse }[]>`
    SELECT computed_at,rule_version,article_ids,board FROM topic_hot_rankings
    WHERE computed_at<=${now} ORDER BY computed_at DESC,id DESC LIMIT 1`;
  if (!saved) {
    const empty = buildTopicHotBoard([], [], now);
    return { board: { ...empty, computedAt: null, refreshAt: new Date((Math.floor(now.getTime() / 30_000) + 1) * 30_000).toISOString() }, materials: [] };
  }
  const [materials, sources, release] = await Promise.all([
    topicMaterials(saved.computed_at, now, saved.article_ids), topicSources(), topicReleaseDeadline(saved.article_ids, now),
  ]);
  const board = buildTopicHotBoard(materials, sources, saved.computed_at,
    { now, truncated: saved.board.coverage.truncated, ruleVersion: saved.rule_version });
  const cutoffs = [saved.computed_at.getTime() + TOPIC_REFRESH_MS, saved.computed_at.getTime() + 3 * TOPIC_REFRESH_MS,
    ...materials.map((m) => m.observedAt.getTime() + HOT_TOPIC_RULES.windowHours * 3_600_000), release?.getTime() ?? Infinity];
  const next = Math.min(...cutoffs.filter((t) => t > now.getTime()));
  // Overdue snapshots are rechecked soon, while still naming their original computation time.
  board.refreshAt = new Date(Number.isFinite(next) ? next : (Math.floor(now.getTime() / 30_000) + 1) * 30_000).toISOString();
  return { board, materials };
}

export async function loadTopicHot(now = new Date()): Promise<TopicHotResponse> {
  return (await read(now)).board;
}

export async function loadTopicHotDetail(slug: string, now = new Date()): Promise<TopicHotDetail | null> {
  if (!/^(?:finance-[a-z0-9-]{1,64}|signal-[a-f0-9]{16})$/.test(slug)) return null;
  const { board, materials } = await read(now);
  const entry = board.entries.find((e) => e.topic.slug === slug);
  if (!entry) return null;
  const from = Math.max(Date.parse(board.computedAt!) - HOT_TOPIC_RULES.windowHours * 3_600_000, now.getTime() - HOT_TOPIC_RULES.windowHours * 3_600_000);
  const links = materials.filter((m) => m.discussion && m.publicNow && m.observedAt.getTime() > from && safeTopicUrl(m.url)
    && matchTopicSignals({ title: m.title, bodyText: m.body, sourceTags: m.sourceTags, discussion: true }).some((t) => t.slug === slug))
    .slice(0, 40).map((m) => ({ sourceName: m.sourceName, url: safeTopicUrl(m.url)!, observedAt: m.observedAt.toISOString() }));
  const { entries: _, ...meta } = board;
  return { board: meta, topic: entry, discussionLinks: links };
}
