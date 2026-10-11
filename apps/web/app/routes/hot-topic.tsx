import { data as withHeaders, Link, useLoaderData } from "react-router";
import type { TopicHotDetail } from "@aihot/contracts/topic-hot";
import type { Route } from "./+types/hot-topic";
import { loadOr404, releaseBoundCache } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { monthDayTime } from "../lib/format";
import { Badge } from "../components/ui/Badge";
import { TopicCoverage, TopicHotCard } from "../features/hot/TopicHotBoard";

export async function loader({ params, request }: Route.LoaderArgs) {
  const upstream = new Headers();
  const detail = await loadOr404<TopicHotDetail>(`/api/site/topic-hot/${encodeURIComponent(params.slug)}`, { signal: request.signal, responseHeaders: upstream });
  return withHeaders(detail, { headers: releaseBoundCache(detail.board.refreshAt, 60, Date.now(), upstream) });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

export function meta({ loaderData, params }: Route.MetaArgs) {
  return pageMeta({
    title: loaderData ? `${loaderData.topic.topic.name} · 题材热点` : "题材不存在",
    description: loaderData?.topic.topic.definition,
    path: `/hot/topic/${encodeURIComponent(params.slug)}`,
    noindex: !loaderData || loaderData.topic.topic.candidate,
  });
}

export default function HotTopicPage() {
  const { board, topic, discussionLinks } = useLoaderData<typeof loader>();
  return (
    <div className="pb-10 pt-5 lg:pt-1">
      <Link to="/hot" prefetch="intent" className="text-[13px] text-accent">← 返回题材热点榜</Link>
      <header className="mb-5 mt-4">
        <h1 className="text-[25px] font-bold leading-snug text-ink">{topic.topic.name}</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-3">过去 {board.windowHours} 小时的讨论与催化。原文明示的题材关联不代表已验证相关板块的市场反应。</p>
      </header>
      <TopicHotCard entry={topic} detail />
      <TopicCoverage board={{ ...board, entries: [topic] }} />

      <section aria-labelledby="topic-catalysts" className="mt-7">
        <h2 id="topic-catalysts" className="text-[18px] font-semibold text-ink">相关报道与状态变化</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-4">保留不同公司、订单与阶段的独立事件；澄清、取消和延期也属于需要追踪的变化。</p>
        {topic.catalysts.length ? (
          <ol className="card mt-3 divide-y divide-line-soft">
            {topic.catalysts.map((catalyst) => (
              <li key={catalyst.itemId} className="p-4 sm:p-5">
                <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-4">
                  <time dateTime={catalyst.publishedAt}>{monthDayTime(catalyst.publishedAt)}</time>
                  <span>{catalyst.sourceName}</span>
                  <Badge tone={catalyst.clarification ? "neutral" : catalyst.firstParty ? "ok" : "accent"}>{catalyst.clarification ? "澄清材料" : catalyst.firstParty ? "第一方材料" : "报道材料"}</Badge>
                </div>
                <h3 className="mt-2 text-[15px] font-semibold leading-relaxed text-ink"><Link to={`/items/${catalyst.itemId}`} prefetch="intent" className="hover:text-accent">{catalyst.title}</Link></h3>
                {catalyst.summary && <p className="mt-1.5 text-[13px] leading-[1.75] text-ink-3">{catalyst.summary}</p>}
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-accent">
                  <a href={catalyst.url} target="_blank" rel="noopener noreferrer">核查原始材料 ↗</a>
                  {catalyst.storyPublicId && <Link to={`/story/${catalyst.storyPublicId}`} prefetch="intent">查看该独立事件 →</Link>}
                </div>
              </li>
            ))}
          </ol>
        ) : <p className="card mt-3 p-5 text-[13px] leading-relaxed text-ink-3">暂时没有可公开核查的事实材料。当前是讨论候选，请保持待核实状态。</p>}
      </section>

      <section aria-labelledby="topic-discussions" className="mt-7">
        <h2 id="topic-discussions" className="text-[18px] font-semibold text-ink">公开讨论材料</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-4">讨论用于追踪关注扩散，不能代替正式公告或作为公司受益的证明。</p>
        {discussionLinks.length ? (
          <ul className="card mt-3 divide-y divide-line-soft">
            {discussionLinks.map((discussion, index) => (
              <li key={`${discussion.url}-${index}`} className="flex flex-wrap items-center justify-between gap-2 p-4 text-[13px]">
                <a href={discussion.url} target="_blank" rel="noopener noreferrer" className="text-accent">{discussion.sourceName} · 查看讨论 ↗</a>
                <time dateTime={discussion.observedAt} className="text-[11.5px] text-ink-4">{monthDayTime(discussion.observedAt)}</time>
              </li>
            ))}
          </ul>
        ) : <p className="card mt-3 p-5 text-[13px] text-ink-3">暂无可公开展示的讨论链接。</p>}
      </section>
    </div>
  );
}
