# AIHOT Project Orchestrator

本项目基于 [AIHOT](https://github.com/KKKKhazix/AIHOT)，目标是中国 A 股 / 财经热点情报系统。当前源码是否已完成财经化须查实际配置；代理定义不代表业务改造已执行。先读 `README.md`，再按任务读 `docs/`。

## 架构原则

- `api` 提供网站、后台与公开接口；`worker` 采集、调用模型、归组和成刊；`web` 只通过 HTTP 读 API。数据库、模型与密钥只在后端，页面读取不触发模型。
- Web、RSS、公开 API、MCP 等出口统一从 `packages/backend/src/publication/` 读取。公开内容匿名一致，后台仅管理员。
- 付费请求必须经过 `providers/receipts.ts` 和预算熔断。开发、测试明确关闭 `COLLECT_ENABLED`、`MODEL_CALLS_ENABLED`、`FEISHU_*_ENABLED`、`INDEXNOW_SUBMIT_ENABLED`，测试不访问外部服务。
- 用户已确认财经 V1 本地假模型测试例外：只在隔离测试进程、虚假凭据、loopback stub 下受控开启模型通路，保留回执/预算和安全阀断言；真实采集、模型、通知仍关闭。该例外不授权真实 Provider 评测或生产调用。
- 行业定制优先在 `industry/`，按 `docs/customize.md` 操作。全文展示默认关闭，只有明确授权的来源才开放；不用 AIHOT 名称或 Logo 作为本站品牌。
- 站名、信源、重要性与噪声、分类、条款和隐私以用户确认的决定为准；未确认的不自行决定。

## 主代理与路由

主代理负责识别领域、拆分任务、协调文件归属、核对授权与风险、验收子代理结果并统一向用户汇报。专业角色定义位于 `.codex/agents/`：

| 任务 | 专业子代理 |
|---|---|
| 财经 Prompt、taxonomy、ITEM_TYPES、分类、评分、精选、标签、实体、主题、事件归组与报告语义、Gold Set | `aihot-finance-agent` |
| RSS/RSSHub、财联社/证券时报/官方信源、json_list/web_list/external、网页抓取、Feed、正文、Jina 采集路径、Source 配置 | `aihot-source-agent` |
| Docker/Linux、PostgreSQL、pg-boss、Worker/API/Web 运行、LLM/GLM/模型能力适配、receipt/budget、日志、内存/swap、部署与恢复 | `aihot-ops-agent` |

按问题所在层路由，不只按文件名：财经 BLOCK 判断交 finance；材料采集交 source；模型请求或队列故障交 ops。跨领域任务由主代理按依赖顺序交接，如 `source → finance`、`finance → ops`。无关通用开发不得塞给专业子代理。

每次委派先读 `docs/agents/common.md`，明确任务目标、只读或可写模式、可修改文件、依赖、验证与授权范围。一个文件同一时间只有一个写入者；不相交的只读检查可并行。涉及未分派文件，先交回主代理协调。

优先按原生角色名调用；客户端没有自定义角色调用入口时，读取对应 TOML 的 `developer_instructions` 和引用文档，完整传给临时子代理；没有子代理工具则由主代理按规则处理并说明。定义是长期规则，不是自动记忆或常驻服务。

## 风险与生产操作

生产检查默认只读。部署、秘密配置变更、生产数据写入/重评、schema/API/核心队列改动先交主代理核对用户已有授权；子代理不得从普通开发任务推断这些授权。

- 未经用户对具体操作明确批准，禁止 DROP/TRUNCATE、批量删除生产 analyses/articles/publications/receipts、`docker compose down -v`、删除 PostgreSQL volume、`git push --force`、`git reset --hard`。
- 不读取、打印或提交实际 `.env`、API Key、密码、session secret、ingest token；检查凭据只报告存在性、长度或配置状态，日志和 Compose 输出也需脱敏。
- 数据更新先只读确认范围，提交具体 SQL/命令、预计影响、备份或恢复方案。schema 变更不得擅自执行；授权后只做向后兼容的增量迁移，编号追加在末尾。
- 命令在目标环境核实过的项目根目录执行，不把本地路径当作服务器路径。部署前检查代码差异、构建影响和数据安全；行业配置/Prompt 入镜像后通常需 rebuild，部署后验证服务、任务与发布链路。

## Git、测试与长期维护

修改前检查 `git status` 和当前 branch/HEAD；保留已有修改，修改后检查 `git diff` 与范围。匹配周围代码风格，使用最小必要改动，不触碰无关文件，不提交 `.env`、密钥或 `.data/`。

应用改动按影响验证；行业改造至少运行：

```text
npm run typecheck
DATABASE_URL=postgres://127.0.0.1:5432/myhot_test node scripts/migrate.ts
DATABASE_URL=postgres://127.0.0.1:5432/myhot_test npm test
npm run build -w @aihot/web
node --test apps/web/tests/*.test.ts
node scripts/smoke.ts --base http://localhost:3000  # 测试站点已运行时
```

测试库必须是独立空库，名称以 `_test` 或 `_ci` 结尾；不用生产库。可替换默认 AI fixture 为财经等价样本，不删测试、不 skip、不降低断言。仅改代理规则时检查 TOML、引用、路由和差异，不为此启动业务或付费服务。

共同工作与返回格式见 `docs/agents/common.md`；历史背景及已确认决定见 `docs/agents/known-state.md`；调用说明见 `docs/agents/README.md`。创建或更新代理体系仅修改 instruction/配置文件，不自动执行行业改造、部署、数据库操作或修改 `.env`。
