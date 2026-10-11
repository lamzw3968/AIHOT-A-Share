// All theme ranking exits read here. Revalidate source roles, withdrawals and release gates live;
// never reuse saved titles or raw discussion bodies, and never enqueue work from a page read.
import { HOT_TOPIC_RULES } from "@aihot/industry/hot-topics";
import type { TopicHotDetail, TopicHotResponse } from "@aihot/contracts/topic-hot";
import { sql } from "../db.ts";
import { buildTopicHotBoard, safeTopicUrl, topicMaterials, topicSources, topicReleaseDeadline, TOPIC_REFRESH_MS, type TopicMaterial } from "../events/topic-heat.ts";
import { matchTopicSignals, topicSignalCache, type TopicSignalInput } from "../sources/topic-signals.ts";

// Keep these inputs identical to buildTopicHotBoard; editorial matching uses the public summary.
const matchInput = (m: TopicMaterial): TopicSignalInput => ({ title: m.title, bodyText: m.discussion ? m.body : m.summary,
  tags: m.discussion ? [] : m.tags, sourceTags: m.sourceTags, discussion: m.discussion });

async function read(at?: Date) {
  const clock = () => at ?? new Date();
  let now = clock();
  const [saved] = await sql<{ computed_at: Date; rule_version: string; article_ids: string[]; board: TopicHotResponse }[]>`
    SELECT computed_at,rule_version,article_ids,board FROM topic_hot_rankings
    WHERE computed_at<=${now} ORDER BY computed_at DESC,id DESC LIMIT 1`;
  if (!saved) {
    const empty = buildTopicHotBoard([], [], now);
    return { board: { ...empty, computedAt: null, refreshAt: new Date((Math.floor(now.getTime() / 30_000) + 1) * 30_000).toISOString() }, materials: [], matches: null, now };
  }
  let materials = await topicMaterials(saved.computed_at, now, saved.article_ids);
  for (let attempt = 0; attempt < 3; attempt++) {
    const matches = await topicSignalCache.prepare(materials.map(matchInput));
    now = clock();
    // Preheating yields: never carry its old visibility, source roles or text into the response.
    const [current, sources, release] = await Promise.all([
      topicMaterials(saved.computed_at, now, saved.article_ids), topicSources(), topicReleaseDeadline(saved.article_ids, now),
    ]);
    now = clock();
    if (!current.every(m => matches.has(matchInput(m))) || (release && release.getTime() <= now.getTime())) {
      materials = current;
      continue;
    }
    const board = matches.run(() => buildTopicHotBoard(current, sources, saved.computed_at,
      { now, truncated: saved.board.coverage.truncated, ruleVersion: saved.rule_version }));
    const cutoffs = [saved.computed_at.getTime() + TOPIC_REFRESH_MS, saved.computed_at.getTime() + 3 * TOPIC_REFRESH_MS,
      ...current.map((m) => m.observedAt.getTime() + HOT_TOPIC_RULES.windowHours * 3_600_000), release?.getTime() ?? Infinity];
    const next = Math.min(...cutoffs.filter((t) => t > now.getTime()));
    // Overdue snapshots are rechecked soon, while still naming their original computation time.
    board.refreshAt = new Date(Number.isFinite(next) ? next : (Math.floor(now.getTime() / 30_000) + 1) * 30_000).toISOString();
    return { board, materials: current, matches, now };
  }
  throw new Error("topic materials kept changing during preparation");
}

export async function loadTopicHot(now?: Date): Promise<TopicHotResponse> {
  return (await read(now)).board;
}

export async function loadTopicHotDetail(slug: string, at?: Date): Promise<TopicHotDetail | null> {
  if (!/^(?:finance-[a-z0-9-]{1,64}|signal-[a-f0-9]{16})$/.test(slug)) return null;
  const { board, materials, matches, now } = await read(at);
  const entry = board.entries.find((e) => e.topic.slug === slug);
  if (!entry) return null;
  const from = Math.max(Date.parse(board.computedAt!) - HOT_TOPIC_RULES.windowHours * 3_600_000, now.getTime() - HOT_TOPIC_RULES.windowHours * 3_600_000);
  const links = matches!.run(() => materials.filter((m) => m.discussion && m.publicNow && m.observedAt.getTime() > from && safeTopicUrl(m.url)
    && matchTopicSignals(matchInput(m)).some((t) => t.slug === slug))
    .slice(0, 40).map((m) => ({ sourceName: m.sourceName, url: safeTopicUrl(m.url)!, observedAt: m.observedAt.toISOString() })));
  const { entries: _, ...meta } = board;
  return { board: meta, topic: entry, discussionLinks: links };
}
