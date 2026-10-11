# 短快讯检查与部署前验收

日期：2026-10-08。分支 `feat/finance-industry-v1`，检查开始时 HEAD 为 `e6ca5d4`、工作区干净。该基础版本已按用户授权推送到 origin；本报告与 RSS 修复、回归测试一同纳入本轮 Git 提交，提交版本及远端同步状态以 Git 记录为准。

## 结论

短快讯缺陷已修复，本地源码、Docker 镜像构建及独立测试库容器验收通过。**生产备份、真实信源/模型、服务器容量与 HTTPS 尚未验收，未执行生产部署。** 没有连接生产服务器、读取实际 `.env`、执行生产迁移或调用真实模型。

## 短快讯缺陷与修复

原 `sources/rss.ts` 拒绝不足或等于 280 字的内容作为完整正文时，excerpt 只读取 description/summary 或 teaser。若 Feed 仅提供短 `content:encoded`、Atom `content`，没有独立摘要，正文和摘要会同时变成 null，原材料丢失。

修复只为未通过正文判定的内容补 excerpt，最多 2000 字。保留原摘要优先、280/281 边界、长正文、teaser、安全清洗与正文状态；短内容仍是 pending，不改评分、接口、schema 或核心队列。带摘要的短快讯原本就能保留；JSON 的 `summaryIsBody` 判定与 RSS 不同，不作统一放宽。

新增 `tests/short-news.test.ts` 的五项固定本地回归测试：修复前 5/5 失败，修复后 5/5 通过。覆盖 RSS/Atom、description、280/281、teaser、JSON 短文、模型输入、提取失败、双评分、回执复用和重复采集。

无法提取的页面将材料置为 unconfirmed，摘要仍进入预筛、评分和写作。固定假模型下 UNKNOWN 继续评分、明确 BLOCK 仍终止；短文不会自动免除预筛。未变材料不会再次走正文提取或产生新模型请求。网络异常的有界重试与修订并发一致性由已有回归测试继续覆盖。本次没有证明真实模型的选稿质量。

历史已丢失的 Feed 文本不会自动恢复。仅重评不能找回缺失材料；需要以后获授权补材料或重新采集，再决定重评范围与预算。

## 本地实际结果

环境：Windows、Node.js 24.15.0、PostgreSQL 17.11；真实外部服务关闭，假模型仅用虚假凭据与 loopback stub。

| 项目 | 结果 |
|---|---|
| 新空本地库迁移 | 39 项，包含 0042；重复执行不重复迁移 |
| 全工作区 typecheck | 通过 |
| 串行后端测试 | 603/603，0 失败、0 跳过 |
| Web 客户端/SSR build | 通过 |
| Web 测试 | 37/37 |
| 独立生产模式 API/Web/Worker 启动 | 通过，仅 loopback、本地测试库、虚假密钥、外部开关关闭 |
| 本地 HTTP smoke | 30 项通过，含 Web/API/RSS/MCP |
| Worker heartbeat、pg-boss 与 topics.rank | 通过；任务 status=ok，生成 1 个快照 |
| 模型榜、监控和自动采集 cron | 关闭的对应 cron 不存在 |
| 新环境 seed | 51 主题、0 信源 |
| 运行测试模型回执 | 0 |
| Compose 静态解析 | 通过；不读取实际 .env、不展开真实环境 |
| Docker build、隔离容器运行 | 通过；详见下方容器验收 |

完整后端用 `aihot_predeploy_20261008_final_test`，运行验证另用 `aihot_predeploy_runtime_20261008_test`，均为新建独立空库，地址 `127.0.0.1:55437`。未复用演示数据或生产库。临时三个进程已清理，用户原来的预览服务保留。

忽略目录日志：`.data/finance-validation/predeploy-backend.log`、`predeploy-typecheck.log`、`predeploy-web-build.log`、`predeploy-web-tests.log`、`predeploy-smoke.log`。测试只验证契约；生产资源、真实源、模型质量和 HTTPS 未在本轮验证。

## Docker 启动故障与本机修复

CLI 28.5.1、Compose v2.40.0 可用。原先没有 Engine 管道；尝试启动已安装的 Docker Desktop 4.48.0 后，后台在初始化 Inference manager 时崩溃，日志指向 `Docker/run/dockerInference`：系统无法访问此文件。WSL 的 docker-desktop 分发为 Stopped。

该路径的元数据为旧的零字节 ReparsePoint。最初将单个残留项改名也被系统拒绝。用户随后授权修复本机 Docker，停止身份已核对的本轮故障进程后，将仅含套接字的父目录同目录改名保留并重建。第一次绕过 Inference 后，启动在 `docker-secrets-engine/engine.sock` 遇到相同错误；元数据确认该目录只有一个零字节套接字，使用相同保留方式后恢复启动。

本次保留目录：

- `%LOCALAPPDATA%/Docker/run.pre-aihot-20261008-122236`
- `%LOCALAPPDATA%/Docker/run.pre-aihot-20261008-122341`
- `%LOCALAPPDATA%/docker-secrets-engine.pre-aihot-20261008-122341`

2026-10-08 12:24 本机显式 `dockerDesktopLinuxEngine` endpoint 的 `docker info` 成功返回 `28.5.1|linux|7|2`；Compose 为 `v2.40.0-desktop.1`。可读取 2 个镜像、4 个 volume、7 个既有容器，容器全部 exited，没有自动启动项目。故障期间没有完整资源清单，不能据此声称逐项数据完整性已校验。

没有删除套接字备份、镜像、volume 或 VHDX，没有恢复出厂设置、重配 WSL、读取秘密内容或修改 Docker 设置。重命名运行目录的临时绕过依据 [Docker 仓库 issue #527](https://github.com/docker/desktop-feedback/issues/527) 中用户的相似故障报告；版本不同，不代表维护者已确认根因或永久修复。第 1 步仅证明本机 Engine 与资源查询恢复；随后完成的镜像和隔离容器验收见下节，未用生产服务器替代测试环境。

## 2026-10-08 Docker 镜像与容器验收

用户明确授权本机镜像构建和独立测试库验收。按当前 Dockerfile 构建，未修改业务代码、Dockerfile、生产 Compose 或实际 `.env`。构建允许下载公开 Node 基础镜像、apt 与锁文件依赖，没有启用真实采集、模型或通知。

- 本地镜像：`myhot-predeploy-20261008:finance-v1`，`linux/amd64`。
- 本地镜像 ID/索引摘要：`sha256:38e70565ff460f488444c937b05bb22938c7467b339b16d3fd2416542ddd89de`；Docker 报告 Size 为 151,203,757 字节。
- 源码基础 `e6ca5d4` 加构建时尚未提交的 RSS 修复；镜像内 `rss.ts` 与 `prefilter.md` SHA-256 和工作区一致。不是纯 `e6ca5d4` 发布产物，没有推送镜像。
- Node.js `24.21.0`、`pg_dump 17.11`；应用 UID 1000。Web client/SSR、行业 Prompt/词表/图片和 0042 迁移均在镜像内，native sharp 可用。
- `npm ci` 和 `npm prune --omit=dev` 成功。TypeScript 仍由生产包 `@react-router/node` 的依赖关系保留，不能以文件存在判定 prune 失败。镜像不含实际 `.env`、`.data`、`.git`。

测试项目 `myhot-predeploy-20261008` 使用全新的 PostgreSQL 17.11 容器及专用 db/data volume。主运行库为 `aihot_docker_20261008_test`；短快讯回归另建 `aihot_docker_short_20261008_test`，不与运行中的 worker 共用库。数据库没有宿主端口，应用和数据库仅接内部网络；所有外部开关明确 false，凭据为虚假测试值。

内部网络下宿主端口最初不可达，宿主 smoke 的 30 项连接失败不是应用故障；容器内 smoke 已通过。随后增加仅用于验收的本地 gateway，双网络连接并固定转发至测试 API/Web，只有 gateway 绑定 `127.0.0.1:55541/55542`，不持有数据库凭据。宿主 smoke 和独立 HTTP 审核随后通过。应用 TCP 外网连接返回 `ENETUNREACH`；没有为测试全局放行 SSRF 或改变 Docker 网络配置。gateway 是测试辅助，不是生产新服务。

| 容器检查 | 实际结果 |
|---|---|
| setup 新空库迁移与 seed | 39 项迁移，51 主题、0 来源、0 文章、0 回执 |
| 重复迁移与 seed | 不重复迁移；既有测试来源和材料保留 |
| API/Web/Worker 与数据库 | 启动正常，API/worker heartbeat 正常 |
| 空站、固定样本 smoke | 各 30 项通过，包含页面、API、RSS、MCP |
| 真实 worker 题材任务 | 手动入队已注册 `cron.topics.rank`；2 次 job completed、job_runs=ok、各 7 项排名，计划 `*/5` |
| 禁用功能调度 | 模型榜、监控、自动采集 cron 不存在 |
| 主代理独立 HTTP 审核 | 22/22；首页 Top5、完整 7 项、候选/澄清、题材与文章详情、API/snapshot/RSS 一致、匿名一致、ETag 304、关闭入口 404 |
| 镜像内短快讯回归 | 5/5，0 失败/跳过；未重新安装开发依赖 |
| 主运行库最终材料 | 7 个禁用虚构来源、30 条虚构文章、6 个人工发布；回执始终 0 |
| 独立短快讯回归库 | 6 张本地假模型回执（分析链路 5 张、BLOCK 1 张），不是外部模型消费 |
| 停止验收 | worker PID 1 收到停止并写出 `worker stopping`；API/Web/worker exit=0，OOMKilled=false |
| 资源保留 | 原 7 容器、2 镜像、4 volume 的标识/状态保留；本次 7 容器已停止，镜像与 2 测试 volume 保留 |

固定材料均标注“虚构测试”，只验证发布与展示契约，不代表采集、模型评分/选稿或市场效果已校准。容器回归只补跑 5 项短快讯测试；603 项完整后端测试的结果仍属于前述 Windows 源码验收，未冒称已在 Linux 镜像内重跑全套。

Docker Engine 本次约 7.63 GiB 可用内存。运行时单次观察 API/Web/worker/db/gateway 分别约 175.8/57.7/88.8/88.5/32.5 MiB，不是峰值、长时间稳定性或 1 GB 生产服务器容量证明。构建版本、生产 CPU 架构、备份可恢复性、HTTPS、实际来源和真实 Provider 需在后续明确授权的部署阶段核对。

忽略目录证据：`docker-build.log`、`docker-setup.log`、`docker-empty-probe.log`、`docker-empty-smoke-internal.log`、`docker-fixture-probe.log`、`docker-fixture-smoke.log`、`container-http-review.log`、`docker-short-tests.log`、`docker-final-probe.log`、`docker-worker-after-stop.log`、`docker-final-{containers,images,volumes}.log`。自包含测试配置为 `.data/finance-validation/docker-compose-preflight.yml`；测试服务已停止，原先 `55438/55439` 源码预览没有改变。

用户随后要求打开网页，测试站已重新启动并保持运行：`http://127.0.0.1:55542/hot`。依赖 setup 随 Compose start 自动重跑，已确认数据库 up to date、同步 51 主题、添加 0 来源；仍保留 30 虚构文章、7 禁用来源、0 回执，外部调用全部关闭。

## 部署前的执行顺序

以下是后续部署方案，不代表已执行或自动获得生产授权。

1. 确认待部署 commit、工作区差异、实际服务器目录与 Linux 架构。RSS 修复需要 rebuild，不能只 restart。
2. 在内存充足、与目标架构一致的机器构建镜像，先验证 Node、非 root 用户、行业 Prompt、Web 产物、PostgreSQL 客户端及生产依赖；再用独立测试数据库验证容器链路。
3. 核实生产 RAM/swap/disk、运行版本与已应用迁移，备份数据库及附件并确认可恢复。
4. 停止旧 API/worker/Web；保留 worker 的 210 秒关闭等待，只运行一次 setup。迁移失败时不继续启动新服务。0042 只增加衍生快照表；若更早迁移未应用，0040 还会审计并修复历史事件文字，不能概括为所有迁移都不影响历史数据。
5. setup 会同步主题，空信源种子不删除或覆盖既有来源；旧 AI 来源也不会自动停用，需要管理员检查。
6. 启动服务后验证健康、worker 心跳、任务、题材快照、文章状态、analyses/receipts/publications 和 HTTP smoke，再按预算逐步启用真实采集与模型。

用户历史服务器约 1 GB RAM，低于文档推荐的构建内存。本地空站运行时 API/worker/Web Working Set 约 189/117/93 MiB，仅为 Windows 单次空载观察，不含 PostgreSQL、系统或容器，不证明 Linux 生产容量。可从 `ANALYZE_CONCURRENCY=1`、`FETCH_CONCURRENCY=2`、`DATABASE_POOL_MAX=3` 的受控初值评估；本轮只在临时进程使用，未修改生产配置。pg-boss 另有连接池，需观察总连接、任务延迟与内存峰值。
