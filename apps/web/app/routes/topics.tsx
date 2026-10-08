import { data as withHeaders, Link, useLoaderData } from "react-router";
import { subjectAfter, withSubject } from "@aihot/industry/site";
import catalog from "@aihot/industry/topics.json";
import type { Route } from "./+types/topics";
import { apiGet, releaseBoundCache } from "../lib/api.server";
import { pageMeta } from "../lib/seo";

interface TopicSummary {
  slug: string;
  name: string;
  group: "company" | "field" | "genre";
  definition: string;
  total: number;
  recent: number;
  indexable: boolean;
  latestAt: string | null;
}

export async function loader({ request }: { request: Request }) {
  const upstream = new Headers();
  const data = await apiGet<{ topics: TopicSummary[]; refreshAt: string | null }>("/api/site/topics", { signal: request.signal, responseHeaders: upstream });
  return withHeaders({ ...data, groups: catalog.groups }, { headers: releaseBoundCache(data.refreshAt, 300, Date.now(), upstream) });
}

export function meta({ loaderData }: Route.MetaArgs) {
  const description = loaderData
    ? `${subjectAfter(`按${loaderData.groups.map((g) => g.name).join("、")}聚合的`, "主题页")}，共 ${loaderData.topics.length} 个主题。`
    : withSubject("主题页");
  return pageMeta({ title: "主题", description, path: "/topics", image: "/og/pages/topics.png" });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

export default function TopicsPage() {
  const { topics, groups } = useLoaderData<typeof loader>();
  return (
    <div className="pb-10">
      <header className="pb-2 pt-5 lg:pt-1">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">{subjectAfter("按题材看")}</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
          先看产业与关注题材，再通过机构和资讯类型查找材料。这里是固定阅读目录；每日讨论排名请查看热点榜。
        </p>
        <Link to="/hot" prefetch="intent" className="mt-3 inline-flex text-[13px] font-semibold text-accent">查看题材热点 Top5 →</Link>
        <p className="mt-2 text-[12px] text-ink-4">共 <span className="num">{topics.length}</span> 个阅读入口，排名与催化按已接入来源统计。</p>
      </header>
      {groups.map((g) => (
        <section key={g.key} aria-labelledby={`topics-${g.key}`} className="pt-8">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h2 id={`topics-${g.key}`} className="text-[15px] font-bold text-ink">
              {g.name}
            </h2>
            <p className="text-[12px] text-ink-4">{g.blurb}</p>
          </div>
          <ul className="mt-3.5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {topics
              .filter((t) => t.group === g.key)
              .map((t) => (
                <li key={t.slug}>
                  <Link
                    to={`/topics/${t.slug}`}
                    prefetch="intent"
                    aria-label={`查看${t.name}相关精选文章`}
                    className="card card-hover group flex h-full flex-col px-5 py-[18px]"
                  >
                    <span className="text-[15px] font-bold text-ink transition-colors group-hover:text-accent">{t.name}</span>
                    <span className="mt-1.5 line-clamp-2 flex-1 text-[12.5px] leading-[1.7] text-ink-3">{t.definition}</span>
                    <span className="mono mt-3 text-[11.5px] text-accent">
                      查看 {t.total} 条精选 <span className="inline-block transition-transform duration-200 group-hover:translate-x-0.5">→</span>
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
