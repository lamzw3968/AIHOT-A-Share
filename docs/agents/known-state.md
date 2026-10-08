# 项目背景与已确认决定

整理日期：2026-10-03（Asia/Shanghai）。本文件用于交接，不是待执行清单，也不授予部署、数据或付费调用权限。区分下列来源；新的用户决定和现场证据出现后更新对应记录。

## 本地源码与代理环境：2026-10-02 财经 V1 实施

- 当前工作区：`E:\AIcurser\Worktree\75e8\AIHOT`。路径是本次观察，其他 checkout/worktree 要重新发现。
- Codex CLI 为 `0.159.0`。原生自定义代理采用 `.codex/agents/*.toml` 的 `name`、`description`、`developer_instructions`；当前会话委派工具未提供自定义角色类型参数，需按 README 的兼容方式读取角色再委派。
- 代理建立前已有根 `AGENTS.md`、指向它的 `CLAUDE.md`、`.claude/launch.json`，以及前一阶段建立的 finance TOML 和调用文档；没有发现项目级 `.agents` 或 Skill 定义。保留现有 Claude 配置，不制造第二套路由。
- 当前分支 `feat/finance-industry-v1`；origin 为用户 fork `lamzw3968/AIHOT-A-Share`，upstream 为 `KKKKhazix/AIHOT`。代理基础设施已提交；用户本轮批准财经 V1 本地实现与验收，不授权推送、部署、真实模型调用或历史重评。
- 财经 V1 修改集中在 industry，另有 publication/API 最小兼容修改及测试。保留 MyHOT/myhot，行业词 A股，关闭两项 AI Feature，空信源种子；实施细节见 `docs/finance-v1.md`。本地差异不代表生产已上线。
- 2026-10-03 本地最终验收：新空 PostgreSQL 17.11 测试库迁移 38 项，后端 579/579、Web 32/32、typecheck、Web build、smoke 30 项通过。Docker Engine 不可用，未验收容器构建；真实模型质量未校准，未推送、部署或重评生产历史。
- Dockerfile 当前基础镜像是 `node:24-trixie-slim`，Compose 使用 `postgres:17-alpine`；行业源码和 Prompt 被复制进镜像。setup 执行 migrate 与 seed，后者对 sources 不覆盖既有 id，对 topics upsert 但不删除旧主题。
- Source 配置字段需从 `sources/config-keys.ts` 核实。RSS/JSON 支持 `summaryIsBody`，其实际正文判定随来源形态和 teaser 检查不同，不保证一定免去详情提取。
- external ingest 当前不直接接收 summary/bodyText；未知外部信源默认 isolated。SSRF 当前没有可配置的精确私网白名单；精确允许范围是未来设计方向，不能编造字段。

## 用户已确认的财经 V1 决定

- 系统是中国 A 股 / 财经热点情报系统，聚合资讯、结构化事件、摘要、研究价值、热点和日报；不做荐股、自动交易、目标价或确定涨跌预测。
- 保留 MyHOT 站名；第一版是财经资讯与事件，不建设行情/财报数据库，只使用现有财经信源，不新增雪球或官方来源。后续用户提出新增任务时再接入。
- 六分类和七种 ITEM_TYPES 见当前 taxonomy。评分保留 0–100、两次独立调用、五维结构：六类事实权重 `3/1/2/4/0`，观点 `1/3/1/4/1`；门槛 T1=60、T1_5=65、T2=76，understandFloor=50，之后用 100–200 条人工 Gold Set 校准。虚构格式样例不构成校准集。
- 财经目录只显示当前 41 个 finance- 主题并按配置排序，历史主题记录、详情 URL、计数和 sitemap 保留；不复用旧 slug。历史失效分类仅公开读取转 null，不改原值或账本。
- 财经版关闭 leaderboard/codexResetMonitor，仅关 Feature，不删模块。站名之外的新品牌、具体信源、条款隐私和全文许可不能自行决定。
- 用户明确确认隔离测试进程的假模型例外：虚假凭据、loopback stub、保留回执和预算；真实采集/模型/通知关闭。此例外不授权真实财经模型评测；数据库仅使用独立本地 PostgreSQL 17 `_test/_ci` 库。

## 用户提供的生产背景：本轮未连接服务器验证

这些是用户报告，不代表当前本地配置，也不保证服务器尚未变化。

| 项目 | 用户提供的背景 |
|---|---|
| 项目路径 | 最新请求给出 `/opt/aihot`；此前要求不要固定此路径。每次在目标服务器核实实际根目录，不能用本地 Windows 路径代替 |
| 部署 | Docker Compose；曾使用 aihot-web-1、aihot-api-1、aihot-worker-1、aihot-db-1，实际名字受项目名和覆盖配置影响 |
| 数据库与队列 | PostgreSQL 17、pg-boss |
| 资源 | 2 vCPU、约 1 GB RAM、4 GB swap、30 GB disk |
| 自动采集与模型 | 曾设置 COLLECT_ENABLED=true、MODEL_CALLS_ENABLED=true；不适用于开发和测试 |
| 模型 | 云端 OpenAI-compatible GLM；不要在此小机器默认部署 Ollama、vLLM、DeepSeek/Qwen 大型本地模型 |

### Docker 网络与镜像历史

用户报告 Docker Hub 网络问题已通过镜像加速/DaoCloud 处理，曾用：

- `m.daocloud.io/docker.io/library/node:24.18.1-trixie-slim`
- `m.daocloud.io/docker.io/library/postgres:17-alpine`，取回后 tag 为 `postgres:17-alpine`

这是服务器历史，不是当前 Dockerfile 的镜像。无新证据不要改镜像架构或重装 Docker。部署时先检查实际镜像、构建上下文、可用内存/swap/disk 和峰值；约 1 GB 内存不能保证直接 rebuild 成功。

### GLM 连接与验证历史

用户报告已成功配置：

```text
LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
LLM_MODEL=glm-5.3-flash
MODEL_CALLS_ENABLED=true
```

源码 `providers/llm.ts` 会追加 `/chat/completions`，不能重复写到 Base URL。曾观察 HTTP 200、AIHOT `chatJson()` 返回 `{ ok: true, message: 'AIHOT GLM connected' }`、`RECEIPT: 1`。没有新证据不要求反复重配或换模型；历史连通不证明所有文章已分析，仍应检查 receipt、analysis、publication。

### Jina 与队列历史

用户 V1 决定为 `JINA_BODY_FALLBACK=false`，不要自行重启此 fallback 或要求购买 Jina。该变量针对正文 fallback，其他 Jina 路径需分别查源码，不能称它关闭了所有 Jina 使用。

历史错误 `extract: JINA_API_KEY is not configured` 曾令文章等待 `processing_retry_at`；`content.sweep` 出现 `status=ok`、`detail={"enqueued":0}`。零入队不等于 worker 坏了，应检查状态、重试时间、排队标记和材料提取。

### 财经文章被 BLOCK 的历史

用户报告曾有约 78 篇 articles；某个观测点为 blocked=49、failed=1、new=28、analyses_count=51。用户确认大量 BLOCK 主要源于默认 AI prefilter，与创新药、房地产、指数、上市公司、资金流、产业新闻不匹配。

这些数字是历史观测，不作为当前计数；BLOCK 不自动代表垃圾。保留旧 articles/analyses/receipts，通过项目实际重评入口生成新分析，不能清库。Prompt 内容哈希改变不会自动重跑历史文章；已有后台 `rerun(..., "analyze", requestId, actor)` 使用新的 attemptTag 和回执，需在未来获授权任务中先小批量验证。

### 信源网络与内容历史

- 已有财经来源包括财联社 CLS，实际来源列表和配置应在任务授权范围内重新检查；不从历史名称猜接口或伪造 Cookie。
- 用户报告 `https://rsshub.app` 曾 timeout，这只能说明对应路由或网络可能有问题，不能断定所有网络故障。
- 用户报告 `https://rss.sina.com.cn/finance/jsy.xml` 曾 HTTP 200 但没有有效 `<item>`；HTTP 200 不等于 Feed 有内容。

## 2026-10-08 本地题材热点改造

来源：用户确认“互联网讨论热度高且可能影响相关板块”、统一 Top5，并授权按讨论修改代码。已新增题材词表与统计/公开读取/网站入口，行业目录 51 个主题，榜单词表 34 个题材，互联网 `#话题#` 可作待核实候选。不推测受益股或行情；来源组不是人数，新闻覆盖与讨论均计关注度，材料状态单列。最小增量迁移为 `0042_topic_hot_rankings.sql`，5 分钟更新，旧事件与 v1/MCP 保留。源码说明与实际验收见 `docs/topic-hot-v1.md`。

本地代码授权不包括生产部署、真实外部服务、秘密配置或历史重评；原财经双评分和门槛继续保留。测试使用独立 loopback 库，任何演示材料明确虚构，不代表真实市场效果。

本地最终验收：新空 PostgreSQL 17.11 库迁移 39 项，598/598 后端测试和 37/37 Web 测试通过，typecheck、Web build、smoke 30 项通过。已有独立预览库增加 30 条明确虚构材料后呈现 7 个题材，其中 Top5 有澄清与待核实样例，预览库 receipts=0；原来的 12 条演示文章保留。未验证 Docker 镜像或真实模型选稿质量。

## 更新记录的方法

更新时写明日期、来源（用户确认/本地源码/服务器只读核查/推断）、适用环境和是否已实施。只保存脱敏状态与结论，不写凭据、Cookie、私钥、真实密码或完整连接串。业务/生产变更完成后按证据更新，不把本次代理配置创建记成财经改造或生产上线。
