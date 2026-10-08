import { Link } from "react-router";
import type { TopicHotEntry, TopicHotResponse } from "@aihot/contracts/topic-hot";
import { Badge } from "../../components/ui/Badge";
import { monthDayTime } from "../../lib/format";

const EVIDENCE = {
  first_party: { label: "第一方材料", tone: "ok" },
  reported: { label: "报道材料", tone: "accent" },
  unverified: { label: "待核实", tone: "amber" },
  clarified: { label: "有澄清材料", tone: "neutral" },
  mixed: { label: "第一方与澄清材料", tone: "amber" },
} as const;

export function TopicEvidence({ status }: { status: TopicHotEntry["evidenceStatus"] }) {
  const value = EVIDENCE[status];
  return <Badge tone={value.tone}>{value.label}</Badge>;
}

function TopicTrend({ entry }: { entry: TopicHotEntry }) {
  if (entry.trend === "unknown") return <span className="text-ink-4">暂不比较 · 覆盖不足</span>;
  if (entry.trend === "new") return <span className="text-accent">新进入统计</span>;
  if (entry.trend === "flat") return <span className="text-ink-4">持平</span>;
  const rising = entry.trend === "up";
  return <span className={rising ? "text-hot" : "text-ink-4"}>{rising ? "升温" : "降温"}{entry.trendPct !== null ? ` ${Math.abs(Math.round(entry.trendPct))}%` : ""}</span>;
}

export function TopicHotCard({ entry, detail = false }: { entry: TopicHotEntry; detail?: boolean }) {
  return (
    <article className="card flex h-full min-w-0 flex-col p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mono text-[12px] font-bold text-hot" aria-label={`题材排名第 ${entry.rank} 位`}>NO.{String(entry.rank).padStart(2, "0")}</span>
        <TopicEvidence status={entry.evidenceStatus} />
        {entry.topic.candidate && <Badge tone="neutral">讨论候选题材</Badge>}
        <span className="ml-auto text-[11.5px]"><TopicTrend entry={entry} /></span>
      </div>
      <h3 className="mt-3 text-[18px] font-bold leading-snug text-ink">
        {detail ? entry.topic.name : <Link to={`/hot/topic/${entry.topic.slug}`} prefetch="intent" className="transition-colors hover:text-accent">{entry.topic.name}</Link>}
      </h3>
      <p className="mt-2 text-[12.5px] leading-[1.7] text-ink-3">{entry.topic.definition}</p>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-[12px] text-ink-4">
        <div><dt>新闻与讨论关注度</dt><dd className="mono mt-0.5 text-[22px] font-semibold text-ink">{Math.round(entry.heat)}</dd></div>
        <div><dt>近 6 小时新增讨论</dt><dd className="num mt-0.5 text-[22px] font-semibold text-ink">{entry.recentDiscussionCount}</dd></div>
        <div><dt>独立来源组</dt><dd className="num mt-0.5 text-ink-2">{entry.sourceGroupCount} · 讨论组 {entry.discussionGroupCount}</dd></div>
        <div><dt>平台覆盖</dt><dd className="num mt-0.5 text-ink-2">{entry.platformCount} 个平台</dd></div>
      </dl>
      <p className="mt-3 text-[11.5px] leading-relaxed text-ink-4">{entry.platformNames.length ? entry.platformNames.join("、") : "暂无可识别平台"} · {entry.storyCount} 个独立事件</p>
      {entry.latestCatalyst ? (
        <div className="mt-3 border-t border-line-soft pt-3">
          <p className="text-[11.5px] font-semibold text-accent">最新相关报道／状态变化</p>
          <Link to={`/items/${entry.latestCatalyst.itemId}`} prefetch="intent" className="mt-1 block text-[13px] leading-relaxed text-ink-2 hover:text-accent">{entry.latestCatalyst.title}</Link>
          <p className="mt-1 text-[11.5px] text-ink-4">{monthDayTime(entry.latestCatalyst.publishedAt)} · {entry.latestCatalyst.sourceName}</p>
        </div>
      ) : <p className="mt-3 text-[12px] text-ink-4">暂无可公开核查的事实催化，讨论关联仍需核实。</p>}
      {!detail && <Link to={`/hot/topic/${entry.topic.slug}`} prefetch="intent" className="mt-auto pt-4 text-[12.5px] font-semibold text-accent">查看事件与原始材料 →</Link>}
    </article>
  );
}

export function TopicHotBoard({ board, limit = 5, title = "题材热点 Top5", more = false }: { board: TopicHotResponse; limit?: number; title?: string; more?: boolean }) {
  const entries = board.entries.slice(0, limit);
  return (
    <section aria-label={title} className="mb-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[19px] font-bold text-ink">{title}</h2>
        {more && <Link to="/hot" prefetch="intent" className="text-[12.5px] text-accent">完整榜单 →</Link>}
      </div>
      <p className="mb-3 text-[12px] leading-relaxed text-ink-4">过去 {board.windowHours} 小时，仅统计已接入来源；少于五个题材时按实际数量展示。</p>
      {entries.length ? (
        <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {entries.map((entry) => <li key={entry.topic.slug} className="min-w-0"><TopicHotCard entry={entry} /></li>)}
        </ol>
      ) : (
        <div className="card px-5 py-7 text-[13px] leading-relaxed text-ink-3">暂无可统计的题材热点。需要近期讨论或财经材料；采集缺口和空数据不会被解释为热度下降。</div>
      )}
      <TopicCoverage board={board} />
    </section>
  );
}

export function TopicCoverage({ board }: { board: TopicHotResponse }) {
  return (
    <div className="mt-3 space-y-1 text-[11.5px] leading-relaxed text-ink-4">
      <p>{board.computedAt ? `${monthDayTime(board.computedAt)} 更新` : "尚未生成统计"} · 独立来源组不是讨论人数，热度不代表涨跌预测。</p>
      <p>尚未接入行情数据，未核验板块涨跌、涨停数量或资金流。</p>
      <p>覆盖 {board.coverage.sourceCount} 个来源，其中 {board.coverage.discussionSourceCount} 个讨论来源、{board.coverage.platformCount} 个平台；点赞、评论与阅读量尚未纳入。</p>
      {board.coverage.behindSourceCount > 0 && <p className="text-amber-ink">采集缺口：{board.coverage.behindSourceCount} 个来源采集落后{board.coverage.behindSourceNames.length ? `（${board.coverage.behindSourceNames.join("、")}）` : ""}，不能将缺失解读为讨论降温。</p>}
      {board.coverage.truncated && <p className="text-amber-ink">本次输入达到处理上限，榜单覆盖不完整。</p>}
      {board.stale && <p className="text-amber-ink">统计尚未刷新，当前显示旧快照，请以更新时间为准。</p>}
    </div>
  );
}
