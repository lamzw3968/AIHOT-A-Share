# 部署

## 用 Docker（推荐）

需要一台装了 Docker（带 Compose）的机器。云服务器建议至少 2 核、4 GB 内存，构建镜像时要用到。

当前 MyHOT 财经版使用用户 fork 的财经分支。约 1 GB 内存的服务器优先使用在同架构、内存充足的机器上构建的镜像；swap 不能替代构建与运行的实测验收。最新本地检查和未完成项见 [部署前验收](predeploy-validation.md)。

百灵与多模型迁移当前在 `feature/multi-model` 分支验收，下面的部署步骤不代表该分支已上线。部署前应确认获准发布的完整 Commit ID、镜像版本和目标环境，不能把旧财经分支的历史验收当作多模型版本验收。Ling 配置、模型能力优先级与协议范围见 [模型配置](models.md)。

```bash
git clone --branch feat/finance-industry-v1 https://github.com/lamzw3968/AIHOT-A-Share.git myhot
cd myhot
node scripts/init-env.ts
```

`init-env.ts` 会生成 `.env`，填好随机密钥和管理员密码，并把密码打印一次；随后在受保护配置中填入模型端点、型号与 Key，避免把真实 Key 放进命令参数、终端记录或 shell 历史。机器上没有 Node 的话，把 `.env.example` 复制成 `.env`，自己填 `ADMIN_PASSWORD`（至少 12 位）、`SESSION_SECRET`、`IMG_PROXY_SIGN_SECRET`、`POSTGRES_PASSWORD`（各用 `openssl rand -hex 32` 生成）和 `LLM_API_KEY`。多模型升级时须核对实际发布 Commit 已包含 0043、Ling、恢复和评测保护代码；下面的财经分支获取示例本身不证明本地多模型成果已发布。

启动前检查 `.env` 的 `SITE_URL`：本机试用保留 `http://localhost:3000`；部署到服务器时改成读者实际访问的地址。例如通过服务器 IP 访问时（把示例 IP 换成自己的）：

```dotenv
SITE_URL=http://192.0.2.10:3000
```

RSS、分享链接、站点地图和 Agent Markdown 中的绝对链接都使用这个值，不会随浏览器访问的地址自动改变。使用域名和 HTTPS 时按下方「配域名和 HTTPS」设置。

配置完成后启动：

```bash
docker compose up -d --build
```

启动后打开 `http://服务器地址:3000`，后台在 `/admin`，用管理员密码登录。当前财经版的信源种子为空，首次启动只同步主题目录，不会自动导入来源或产生新闻。通过 `/admin/sources` 配置信源并预览有效条目后，确认 Worker 运行以及采集、模型开关和预算；保存信源不保证已经分析或公开发布。升级时既有数据库来源保留，重复 seed 不覆盖它们。

`docker compose` 会起五个容器：`db`（PostgreSQL 17）、`setup`（每次启动先跑数据库迁移和种子数据，然后退出）、`api`、`worker`（抓取、模型处理、定时任务）、`web`（网页）。

### 在中国大陆的服务器上

- 构建时 npm 走国内镜像：`docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com`，然后 `docker compose up -d`。
- 拉取 Docker 镜像慢，先给 Docker 配置镜像加速。
- 海外信源抓不到时，在 `.env` 里设置 `EGRESS_PROXY_URL`：抓信源、图片和模型榜数据时走这个代理，调用模型接口不走。
- 对外提供网站服务需要先完成 ICP 备案，备案号填在 `industry/site.ts` 的 `icp`。

### 配域名和 HTTPS

先把域名解析到服务器，然后在 `.env` 里设置：

```bash
SITE_URL=https://example.com
SITE_DOMAIN=example.com
PORT=127.0.0.1:3000        # 3000 端口只给本机的 Caddy 用，不直接对外
TRUST_PROXY=true           # 访客地址从 Caddy 转来的请求头里读
```

再用带 HTTPS 的方式启动，Caddy 会自动申请和续期证书：

```bash
docker compose --profile https up -d --build
```

已经有 Nginx 的话，不用 Caddy，把站点反向代理到 `http://127.0.0.1:3000`，带上 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`，并在 `.env` 里设 `TRUST_PROXY=true`。`SITE_URL` 一定要写成读者实际访问的地址：生成的链接、RSS、分享图和 MCP 都用它。

MCP 默认接受 `SITE_URL` 的主机以及 `localhost`、`127.0.0.1`、`[::1]`。额外主机用 `MCP_ALLOWED_HOSTS` 配置，以逗号分隔，例如 `extra.example:8443,[2001:db8::1]`。主机名不区分大小写，IPv6 必须加方括号；可带 0–65535 的十进制端口，匹配时忽略端口。包含路径、用户信息或非法端口的配置不会生效。`127.1` 等别名需要明确列入；此配置只影响 Host 校验，不扩大浏览器 Origin 许可。

### 更新

先核实服务器上的项目根目录、Compose 项目名、覆盖文件、当前 Commit/镜像和未提交修改，取得对应版本后按下节备份数据库及附件。不要用未经检查的 `git pull` 覆盖现场。以下命令在已确认的项目根目录执行；有覆盖文件、项目名或 HTTPS profile 时，全部命令使用相同参数：

```bash
docker compose build
docker compose stop api worker web
docker compose run --rm setup && docker compose up -d
```

构建完成后停止所有旧版 API、Worker、评测脚本和其他可能调用模型或写业务数据的进程，再单实例运行 setup。迁移成功后再启动服务；迁移失败时先查看错误，不要继续启动。使用 HTTPS 配置的站点继续保留 `--profile https`。不要并行运行多个 setup 或混跑新旧模型调用进程：旧版不参与共享 Quota，可能绕过同账号限流。

历史撤回修复迁移会把失效事件文字存入后台审计，再按仍可公开的报道回退显示，不会在迁移中调用模型；停止旧 API 和 Worker 可避免旧任务把失效文字写回。正常关闭 Worker 会等待正在处理的任务退出：当前 `STOP_TIMEOUT_MS=195000`，Compose 的 `stop_grace_period=210s`，应保留足够关闭时间。强杀正在发送付费请求的进程可能留下 `unknown` 回执。非 Docker 部署也按“备份、构建、停止 API/Worker/Web、迁移、启动”的顺序更新。

镜像包含后端 TypeScript、行业配置、Prompt 及 Web 构建产物；修改宿主源码后只做 restart 不会更新镜像。修改环境配置后需要重建容器使所有相关进程加载相同配置；后台模型能力选择保存在数据库中，按后台配置生效，不需要重新构建镜像。

### 多模型版本的 0043 迁移

`0043_provider_quotas.sql` 只新增运行协调表，不改写旧文章、分析、公开内容、预算、回执或 attempt。通过 `0042` 的代码基线有 39 个 SQL 文件，当前含 `0043` 共 40 个；历史编号有空号，不能按编号认定应有 43 条账本。

| 新表 | 用途与约束 |
|---|---|
| `provider_quotas` | 摘要形式的 `quota_key` 主键；保存下一次准入时间、429 冷却时间和非负连续限流次数 |
| `provider_quota_leases` | UUID 主键、到期时间；外键指向 Quota，`ON DELETE CASCADE` 仅作用于该新租约表；索引 `(quota_key, expires_at)` |
| `provider_deferred_jobs` | UUID 主键、唯一 `current_job_id`；保存队列名、原 payload/options、原创建时间、失败已消耗量、剩余重试数、绝对到期时间和恢复时间；失败计数非负；状态限定为 `waiting/dispatched/finished/expired`，有 `waiting` 到期扫描的部分索引 |

升级前只读核对目标库的 `schema_migrations`、三张同名表及其约束/索引。`scripts/migrate.ts` 按文件名排序，每个文件的 DDL 和账本插入在同一事务中；已登记的文件按名称跳过，没有内容摘要检查，也没有全局迁移锁。`0043` 不使用 `IF NOT EXISTS`：有表但没有相应账本、账本与结构不符、同编号不同文件或迁移内容冲突时停止核对，不改账本、不改已应用 SQL，也不用忽略错误的 DDL 绕过冲突。重复执行脚本应显示数据库已是最新；直接重放原始 SQL 并不幂等。

先在独立本地 `_test/_ci` 库验收空库 40 项全迁移、39 项基线升级到 0043、重复运行不新增、迁移失败时 DDL 与该文件账本一起回滚。检查三表 PK/FK/CHECK 和两个索引、部署账号读写权限、数据库时钟、连接/磁盘余量与锁等待；按维护窗口设置合适的数据库 `lock_timeout`/`statement_timeout`，不要把等待无限延长。升级前后比较旧业务、回执/attempt、预算的计数和关键内容，保留原消费历史。

Compose setup 同时执行 migrate 和 seed，后者会同步主题目录，并只补缺失的信源，不覆盖已有来源 id；当前财经版来源种子为空。单独验证迁移时直接运行 `scripts/migrate.ts`，避免把 seed 的主题写入混为迁移影响。生产迁移另需明确授权、可恢复备份和实际升级核对，本地验收不代替这些要求。

### Worker 恢复与限流诊断

Ling 调用使用 PostgreSQL 共享 QPS 和并发租约，同一数据库中使用相同 Provider、规范化路由与 Key 摘要，或相同 Provider 与显式 Quota 组的进程共用额度。额度不是账号真实限额的自动发现；未接入 Quota 的其他现有模型仍沿用原请求路径。429 的 `Retry-After` 秒数/HTTP 日期用于共享冷却，无有效值时采用有抖动的退避。共享 QPS 不能保证 Provider 的 TPM、每日 token 或金额限制；所有消费者必须在真实账号范围内协调。

| 情况 | 当前处理与检查位置 |
|---|---|
| 请求尚未发送、准入不足 | 短等待在事务外有限重试；仍不能准入时抛 `ProviderDeferredError`，不创建付费 attempt、不消耗业务失败额度 |
| 队列任务遇到未发送等待 | `provider_deferred_jobs` 和原 pg-boss claim 完成在同一短事务中提交；Worker 的 `providers.resume` 每分钟检查到期行，行锁 `SKIP LOCKED` 与事务内 send/指针更新防止两个恢复器重复投递 |
| content 分析等待 | 使用 `processing_retry_at`，不增加 `processing_attempts`；原 `content.sweep` 每 5 分钟检查合格内容并重新入队，不一定产生延期表记录 |
| 实际发送后收到 429 | 记录真实失败 attempt，并共享冷却；沿原失败/重试语义处理，不伪装成未发送等待 |
| 网络结果不明或进程异常退出 | 回执保持 `unknown`，准入租约到期只释放并发占用，不释放逻辑回执；延期恢复不会绕过回执重发 |

恢复保留原 payload（含 attempt tag）、priority、singleton key、group/heartbeat/dead-letter 等已支持选项、剩余失败额度、原绝对 expiry 和报告日期。重新创建 pg-boss 任务会将原生 `retryCount` 从零开始：剩余重试次数保留，指数退避阶段会重置。当前 pg-boss 为 `12.34.0`，恢复不支持带时间窗口的 throttle/debounce singleton，会显式报错；不能擅自把这种任务扩展到现有恢复路径。

singleton 冲突/队列不可用会继续保留 `waiting`，约一分钟后重试；派发异常回滚事务并记录脱敏 `reason`。达到原 expiry 后标记 `expired`，不延长任务生命；派发任务已完成、失败、取消或缺失时收敛为 `finished` 并保留原因，任务缺失时先核对回执而非盲目补发。当前没有独立的 `error` 状态：诊断查 `status/reason/resume_at/expires_at/current_job_id`，并结合 `pgboss.job`、`job_runs`、Worker 心跳和文章处理字段。终态协调行在原 expiry 超过 7 天后限量清理；该清理不删除业务数据或付费回执。`waiting/dispatched` 持续增长、`reason` 反复出现或任务到期应告警，不能只看容器存活。

翻译、引用翻译及报告补刊的 Provider 暂停会向上透传。辅助事件 `consolidate` 仍是归组后的 best-effort 步骤：失败写入任务结果的 `consolidationError`，目前没有独立持久恢复队列；`providers.resume` 不保证补做该步骤，属于上线前明确接受或另行开发的缺口。

`ops.recover` 每 10 分钟将陈旧 `pending` 回执标为 `unknown`；不会因 unknown 已过 30 分钟、准入租约到期或 Worker 重启而自动放行。租约释放、回执核账、授权重发和实际重新发送是不同步骤：租约只管理并发占用，核账也不等于已经取得可用响应。发送后断连或响应保存失败以脱敏错误关联 `receiptId`；数据库故障可能暂留 `pending`，不能据此重发。

需要恢复时先在供应商核对该 `receiptId` 对应请求及账单，再由管理员在“运行”页选择计费结论并填写说明，执行“记录并放行”。此动作同时授权重发，可能再次计费；回执改为 `failed`，历史 unknown attempt 不改写，核账与 `resendAuthorized: true` 同事务写入 `receipt.release` 审计。文章按既有流程重新排队，并不继承旧 pg-boss 任务期限；关联失败队列任务及 Deferred 续任务受原期限约束，过期旧任务不复活。因 unknown 失败且零剩余原生重试的队列任务仍须明确授权。恢复后若再次 unknown，仍须人工核对授权。排障和回滚不能删回执、换 attempt tag、复制任务或沿用旧自动放行标记绕过保护。

### 回滚与上线前检查

应用回滚应先关闭新任务入口、停止所有调用进程并确认在途结果已保存，再切回已验证的镜像与配置。保留 `0043` 三表、迁移账本、延期记录、预算与全部回执；没有自动 down 迁移，不删表或清空队列。旧镜像不会消费 `provider_deferred_jobs`，也可能不识别 Ling 配置：回滚前列出等待/派发任务及原 expiry，确定暂停、后续恢复或专门补偿方案，不能以旧服务启动成功宣称任务已恢复。数据库恢复是另一项操作，会丢失备份之后的新回执/业务写入；先停写并单独核对恢复范围，避免用旧备份把已付费请求变成可重发。

回滚目标还须包含 7A 的 unknown 人工授权保护；回到 7A 之前的镜像会重新引入旧超时自动放行，保留新表和回执本身不能保证新策略。若目标不含该保护，应保持所有付费调用进程停止、外部功能关闭，并先制定 unknown 核账与任务交接方案，不能直接恢复付费任务。新 Worker 的通用队列包装会读取 `provider_deferred_jobs`，因此 0043 必须在新 Worker 启用前完成；单实例迁移并核对账本/结构后，再启动一致版本的 API、Web 和 Worker，观察心跳、`providers.resume`、`content.sweep` 与到期/失败诊断。

上线前逐项记录实际证据与负责人：

- 核实发布 Commit/镜像、同架构构建、Web 产物、资源峰值和总数据库连接（业务池与 pg-boss 池分别占用）；约 1 GB 主机仍需独立容量评估。
- 验证备份数据库与附件能成对恢复到独立库，记录维护窗口、停止旧进程顺序、单实例迁移、失败回退与延期任务交接办法。
- 检查 0043 账本/结构、旧数据与消费记录保护、时间同步、Worker `providers.resume/content.sweep`、重启/竞争恢复及任务过期诊断。
- 按真实账号确认 Ling 型号、官方端点、响应/错误协议、输出 token 上限、QPS/并发/TPM、每日额度、计费与 Retry-After；当前 Mock 兼容验收没有证明真实接口可用或账号允许这些额度。真实调用必须另有费用授权。
- 确认所有共享该账号的进程使用同一数据库/Quota 分组；不同 Key 默认分组不同，第三方消费者不会自动纳入协调。核对 GLM 及其他既有能力映射，不因默认模型变更而误改全部步骤。
- 检查 `llm` 预算行及每分钟/每小时/每日请求数：Ling 命名预设和默认模型共用 `llm`，命名 GLM 预设使用 `zhipu`。预算缺行代表不限额，任一窗口小于等于 0 会暂停该服务；请求数预算不是 token 或金额上限。
- 完整后端、GLM/Ling/Quota/Receipts/Deferred/评测专项、TypeScript、Web 构建/测试和隔离容器验收分别留日志；测试失败保留现场，区分禁用端口、资源/时间波动与真实行为回归。不完整评测退出 2、指标不可排名，自动和手工 SelectBench 导入均拒绝；已有评测链排空时仍可能发出第二次评分请求。
- 保留第五阶段此前全量分别 1、4、7 项失败及 7B 三轮 `741/741、740/741、741/741` 的记录。7B 第二轮评测子进程异常退出 `0xC0000409`，根因仍未定位；历史 `alerts` 文件级异常与缺完整 cause 的 `source` 失败也不能统一归因于禁用端口。7B 已修复 Stub 的 Fetch 禁用端口 3659/6669 与预算滚动窗口的已知触发条件；后续全绿不能证明上述未定位异常已经解决。
- 明确辅助 `consolidate` 独立恢复未覆盖、纯汇总历史评测报告无法反证原始样本覆盖率、真实 Ling 质量与 Provider 账单未验证，确认这些限制是否允许上线。

### 隔离 Docker 验收

验收使用独立 Compose 项目/容器名、测试镜像 tag、新建 `_test/_ci` 数据库和独立数据卷；先盘点既有资源，保留旧容器、镜像及卷。不直接启动仓库默认 Compose 作为测试：它会读取真实 `.env`，默认项目名、数据库名和卷也可能与已有站点冲突。使用单独临时 Compose 文件并显式给出隔离配置，不继承真实凭据、`AIHOT_CREDENTIALS_DIR` 或主机数据目录，不打印展开后的秘密配置。

应用运行网络设为内部隔离网络，只把验收端口绑定 `127.0.0.1`，与生产网络/数据库无路由。显式关闭 `COLLECT_ENABLED`、`MODEL_CALLS_ENABLED`、`FEISHU_CONTENT_PUSH_ENABLED`、`FEISHU_INTERNAL_ENABLED`、`INDEXNOW_SUBMIT_ENABLED`。需要验证模型通路时仅在隔离测试进程使用本地假 Provider、虚假模型 Key、出站拦截及真实回执/预算逻辑，不授权容器访问真实模型接口。镜像构建拉依赖与应用运行的网络隔离分别检查。

验证镜像内 Node/Web 产物、setup 的 40 项迁移与 seed、非 root 身份、API/Web/Worker/数据库健康、实际 pg-boss 恢复与重启、空站回执为零，以及本地 smoke；有付费 attempt 时逐一确认只来自 loopback Mock。正常停止本次测试服务并保留日志/数据卷，不执行 `down -v` 或清理非本次资源。工具或资源条件不足时明确列出未运行项，不能用宿主测试替代镜像验收结果。

当前 Dockerfile 会在构建末尾 `npm prune --omit=dev`，生产镜像不包含完整测试依赖（例如 `@modelcontextprotocol/client`）。完整容器回归应使用同源码、同 lockfile 且安装开发依赖的独立测试镜像；生产镜像另验收启动、迁移、Worker 和 HTTP 出口，不能把缺测试依赖误报为业务回归。

`scripts/eval-selection.ts` 已改为写 `config.dataDir/eval`。Compose 的 `AIHOT_DATA_DIR=/data` 与 `data:/data` 使报告落在 `/data/eval`；默认宿主机路径仍为源码根目录 `.data/eval`。脚本在模型请求前实际写探针，不可写时发送 0 次请求。镜像中 `/app` 顶层由 `WORKDIR` 创建，仍属 root；`COPY --chown` 不改变该已存在顶层目录，`/data` 则为 UID 1000 准备可写。自定义绑定挂载需另核对 UID/GID、ACL 与只读属性，不要扩大整个 `/app` 的权限或用 root 调模型。

获准运行容器评测时，`--gold /data/gold.jsonl` 可显式读取放入数据卷的样本；`--gold .data/gold.jsonl` 仍指源码根目录下的输入，不会自动跟随输出配置。旧 `/app/.data/eval` 文件不会自动搬迁。7C 在非 root、只读根文件系统和内部网络下，使用 Mock 生成正常及中断报告；实际 `force-recreate` 后同一命名卷中的两份报告 SHA256、回执及 SelectBench 计数均保持，中断报告仍拒绝导入。

7C Linux 完整后端首轮 `741/745`，缺少默认 `/app/.data` 测试写权限导致 4 项失败；为默认宿主路径测试及旧 relation CLI 提供额外的 UID 1000 可写 tmpfs 后 `745/745`，没有放宽生产权限或降低断言。完整回归需要该测试挂载；它不是生产持久化方案。`scripts/eval-relations.ts` 仍使用旧硬编码目录，且未接入 selection CLI 的写入预检；这是另行修复任务，当前不在容器中运行该真实付费评测。

### 第六阶段本地验收记录（2026-10-14）

代码基线为 `feature/multi-model` 的 `9d9f4bc4a76ee522a1badc368bb27fcde69b38ec`。以下结果来自独立空测试库、虚假凭据和本地 Mock；专项与全量包含重叠测试，不累加为新的总数。本阶段只修改配置示例与文档，没有修复业务代码或测试。

| 验收项 | 实际结果 |
|---|---|
| 宿主完整后端第一轮 | 727 项：709 通过、18 失败、0 跳过；17 项由 Ling Stub 绑定 Fetch 禁用端口 6669 引发，1 项为评测预算时间窗断言失败 |
| 宿主完整后端第二轮 | 727/727 通过，0 失败、0 跳过；未使用端口重绑定补丁 |
| 模型与评测兼容专项 | 128/128 通过，包含原 GLM 13 项以及 Ling、Quota、Receipts、Deferred、后台和评测保护 |
| TypeScript 与 Web | 主项目及评测脚本类型检查通过；Web 构建通过；Web 测试 37/37 通过 |
| 独立数据库迁移 | 75 项检查通过，0 意外失败；空库 40 文件、0042 基线 39 文件升级、重复运行、约束/索引及旧数据保护均验证；另有 1 次刻意制造的同名表冲突按预期失败，DDL 与 0043 账本回滚，未绕过冲突 |
| 生产镜像运行验收 | 原 Dockerfile 构建通过；独立 setup 应用 40 文件并种入 51 主题、0 信源；API/Web/Worker 正常；本地 smoke 30/30 通过；运行库 receipt/attempt 均为 0 |
| 实际 Worker 重启恢复 | 真实 pg-boss 任务持久延期后，启动 Worker，由定时恢复器重投并完成；priority 19、剩余重试额度 2 保留，无 Provider HTTP |
| 首轮容器完整测试 | 716 项：701 通过、15 失败；生产镜像缺开发测试依赖造成 1 个文件加载失败，另 14 项因评测产物目录不可写失败；该轮不能算完整通过 |
| 独立测试镜像完整后端 | 使用相同源码/lockfile、补齐开发依赖并准备评测产物目录后，727/727 通过，0 失败、0 跳过；没有修改断言或业务实现 |

偶发失败调查仍有未闭环项。此主机 TCP 动态端口范围为 1024–15000，会分配到 Fetch 禁用端口；受控探针确认 6669 上原生 HTTP 正常，但 Fetch 在发请求前报 `bad port`。这与第五阶段已确认的 3659 问题一致，属于环境触发的测试 fixture 缺陷，需要另行批准测试修改；不代表 Ling 协议本身失败。第五阶段首次 `alerts` 文件级异常及另一次 4 项 source 失败缺少底层原因，仍未定位，不能统一归因为端口。本阶段两个全量的 alerts 均通过，另在独立空库专项 1/1 通过，也不足以证明历史异常消失。

本轮预算断言的数据库证据显示：fixture 读取一分钟消费后，CLI 启动约 0.709 秒期间有两笔历史 attempt 滑出窗口，使实际可用额度增加。预算按滚动窗口计算符合现有实现，但测试假定窗口不变；需要隔离该测试的历史消费/时间窗，而不是降低断言。端口 fixture 与预算 fixture 均未在本阶段修改，后续复测应继续保留原始失败日志。

真实 Ling 请求、账号权限/额度、TPM、实际费用和模型质量均未验收；辅助 `consolidate` 独立恢复、未知付费结果原有一次自动放行风险、恢复后指数退避阶段重置，以及生产容器 CLI 产物路径问题继续保留为上线检查项。宿主和容器各一次全绿不构成稳定性问题已解决的结论。验收日志及隔离数据保留在本轮临时验收目录，测试服务验收后停止，不删除数据卷。

以上是第六阶段当时的记录。后续 7A 已取消 unknown 超时自动放行并修复 `receiptId` 关联；7B 已修复禁用端口及预算历史窗口 fixture，但新增发现的 `0xC0000409` 和历史 alerts/source 异常仍未定位；7C 已修复 selection 评测目录与持久化。不要用历史记录中的旧恢复策略操作当前版本；当前边界见本节前文与下列 7D 清单。

### 多模型 PR 准备清单（7D，2026-10-15）

复核范围为本地 `main`（`c779db15808da30b977de5e83a6b1d92e01ad609`）到 `8ce4e5f3a102714b08d6d657b6e811b6c25eada1` 的 9 个 Commit、61 个文件。本轮只同步 `models.md`、`deploy.md`、`selection.md`，未发现必须修改的新增运行代码或测试缺陷。没有修改 main、行业配置、既有财经成果、备份实现或真实环境配置。

| 验收项 | 7D 实际结果 |
|---|---|
| 宿主完整后端 | 两轮均 `745/745`，退出 0，跳过 0 |
| Linux 完整后端 | `745/745`，退出 0，跳过 0；保留默认目录测试 tmpfs |
| Web / TypeScript | Web 测试 `37/37`，Web 构建与 `npm run typecheck` 通过 |
| Docker 站点 / 后台 | 容器内 smoke `30/30`；管理员鉴权、11 项能力、GLM/Ling 展示、切换恢复及中断报告导入拒绝通过，空站模型 receipt/attempt 为 0 |
| Docker Worker / 评测 recreate | 新 Worker 恢复零剩余重试额度的未发送停车任务，payload/原期限保留，无重复派发；正常与中断报告同卷 SHA256/计数不变，不可写目录 0 请求 |
| 隔离迁移 | 空库 40 文件；39→40 增量仅应用 0043，重复运行无变化；使用实际 0043 DDL 与账本事务注入失败后整体回滚，模拟旧预算/unknown 回执与 attempt 保持 |

本轮复用 7C 生产及完整测试依赖镜像，逐文件核对应用、测试、配置及迁移与当前 HEAD 一致；镜像内 Dockerfile 是 7C 为命名构建阶段及追加开发依赖阶段使用的临时版本，文档不属于运行时源码。所有运行进程非 root、使用内部隔离网络、独立测试库/卷和虚假凭据，外部功能关闭；模型通路仅在 loopback Mock 子进程受控开启。宿主机 smoke 首次因内部网络没有实际发布端口而连接拒绝，失败与完整 cause 保留；从 Web 容器 loopback 执行同一 smoke 后全部通过，不改变断言。最初镜像哈希检查对临时 Dockerfile 元数据预期不符也保留，核对已知构建版本后通过。

最终只读数据库快照首次因临时诊断 SQL 的大小写别名未加引号而断言失败；修正该脚本后成功补采，空站 receipt/attempt 和 SelectBench 写入均为 0，真实 Worker 派发记录与终态停车行有证据。原失败文件保留，没有将空快照记为成功，也没有修改仓库测试。

`.env.example` 已核对且无需修改：Ling 独立凭据对、严格回退、参数和共享配额注释与实现一致，真实 Key 留空。模板保留部署用途的 `COLLECT_ENABLED=true` / `MODEL_CALLS_ENABLED=true`；本地开发和普通测试仍须显式关闭。Compose 显式设置 `/data`，宿主机默认 `.data`，自定义 `AIHOT_DATA_DIR` 按前文配置。

| 分级 | 合并或后续处置 |
|---|---|
| 文档阻断处理 | 7D 首轮发现 [architecture.md](architecture.md) 的旧 unknown 超时自动放行说明；经后续授权已同步为人工核账并明确授权重发，保留重复计费风险，该文档阻断已解除 |
| 需明确保留的风险 | 7B `0xC0000409` 与历史 alerts/source 尚无根因；本轮未复现，不能宣称稳定性已解决，再复现应重新阻断验收。人工核账后重发仍可能再次计费，数据库故障可能暂留 pending，预检后最终落盘仍可能失败 |
| 已知兼容取舍 | Deferred 原生退避阶段重置、时间窗 singleton 不支持、历史 summary-only 无法反证覆盖、辅助 consolidate 没有独立持久恢复；维持当前明确边界，不承诺 exactly once |
| 后续独立任务 | 调查 Windows 原生退出和历史 alerts/source，补齐子进程 PID/UTC/端口及必要崩溃转储；7B 六次评测复跑虽通过，数据库快照因缺 pgboss.job 未成功，不能用作状态证据。旧 eval-relations 的目录/预检及 eval 异地备份另行处理 |
| 真实 Ling 启用前阻断 | 账号权限、协议、QPS/并发/TPM、计费与质量未经真实验证；不阻止以 Mock 证据评审代码，但启用真实付费链路前须单独取得费用授权并验收 |

建议 PR 标题：`feat(models): add Ling support with shared quotas and safe receipt recovery`。提交范围应包含获准的代码、测试、配置和同步文档，排除未跟踪迁移审计报告及全部诊断证据；测试与风险描述保留实际失败。生产顺序仅提出：核对 revision/结构并备份 → 停全部旧调用进程并排空 → 单实例应用 0043（确认 seed 副作用）→ 启动一致版本 API/Web/Worker → 检查心跳、恢复、预算、回执和发布出口。本轮没有执行生产迁移、部署、Commit、Push、Merge 或创建 PR。

### 管理员会话与配置变更

会话绑定迁移排在 `0041`。此前已试用会话绑定迁移的数据库可直接升级，已有列和绑定会被保留，无需手动修改迁移记录。

会话绑定登录方式、登录时的管理员凭据或飞书身份。升级到会话绑定版本后，未绑定的旧会话需要重新登录。修改管理员密码、飞书管理员名单或会话密钥后，应重启所有 API 进程，使它们加载相同的新配置；只编辑配置文件不代表正在运行的进程已生效，混用旧代码或旧配置的进程不能提供统一撤权。

有效配置改变后，密码会话不再接受旧密码的授权，飞书会话按登录时实际取得的 union ID 或邮箱检查当前名单（两者任一仍获授权即可）。停用飞书登录应用或更换应用 ID 会使飞书会话失效；只轮换同一应用的 secret 不会使仍获授权的飞书会话退出。轮换或移除 SESSION_SECRET 会使两种会话都失效。

鉴权时确认失效的会话会被删除，恢复旧配置也不会让它复活。系统不记录全局凭据变更历史：某次配置变化若从未被进程加载，或在恢复前从未被会话检查观察到，不能据此追溯撤销会话。

### 备份

在 `.env` 里配置 `DB_BACKUP_STORE_*`（任何 S3 兼容的对象存储），每天 04:10 自动备份到那里。一次完整备份包含同一时间戳的数据库 `.dump` 和文件 `aihot-files-*.tar.gz`：文件包保留 `uploads/` 以及仍存本地的 `feedback-screenshots/`，不包含图片缓存、本地备份目录或评测 `eval/`。评测报告在数据卷内可跨容器 recreate 保留，但不等于已有异地备份；需要保存原始报告时另行安排复制与恢复验证，不能宣称数据库备份能恢复这些 JSON 文件。已经转发到飞书的图片只保留数据库中的外部引用，文件包不保存飞书上的图片。

恢复时同时取回这一对文件：使用与数据库版本兼容的 `pg_restore` 将 `.dump` 恢复到空数据库，再把文件包解压到数据目录根目录（Docker 中为 `/data`，非 Docker 使用 `AIHOT_DATA_DIR`，默认 `.data`），保留包内的子目录结构，并确保运行进程可读取这些文件。只恢复数据库不能找回仍由 `local:` 引用的反馈截图；旧备份中没有包含的文件也无法凭数据库引用恢复。

下面的手动导出只包含数据库，不包含上述附件目录：

```bash
docker compose exec -T db pg_dump -U aihot aihot | gzip > myhot-$(date +%F).sql.gz
```

数据都在三个 Docker 卷里：`db`（数据库）、`data`（上传的图片、图片缓存、本地备份）、`caddy`（证书）。`docker compose down` 不会删除它们；`docker compose down -v` 会。

### 看日志

```bash
docker compose logs -f --tail 100 api worker web
```

后台的“运行”页能看到每个定时任务最近的结果，“信源”页能看到每个信源的抓取状况。

## 花多少钱

- **模型**：每条新资料至少预筛一次；可能入选的再评分两次，入选的还要写标题摘要、打标签、归组，另外还有日报和事件综述。我们用示范信源在本地试跑，第一次导入的 152 条资料一共用了大约 930 次模型调用。之后每天用多少，取决于你的信源每天更新多少条。后台“模型与评测”页能看到每一步的调用次数和输入输出 token 数。
- **付费采集**（X、公众号、Jina）：按请求计费，默认不启用，填了 key 才会用。
- 付费服务按后台“设置 → 预算”中每分钟、每小时、滚动 24 小时的请求数限额暂停；任一窗口小于等于 0 会停用该服务，预算行缺失则不限请求数。这不是 token 或金额上限，仍需核对供应商账单及账号限额。

## 不用 Docker

需要 Node.js 24.11 以上和 PostgreSQL 16 或 17。

```bash
npm ci
node scripts/init-env.ts
createdb myhot
```

在 `.env` 里加上：

```bash
DATABASE_URL=postgres://你的用户名@127.0.0.1:5432/myhot
API_BASE_URL=http://127.0.0.1:3001
```

然后：

```bash
node --env-file=.env scripts/migrate.ts
node --env-file=.env scripts/seed.ts
npm run build -w @aihot/web

node --env-file=.env apps/api/src/main.ts          # 接口，3001 端口
node --env-file=.env apps/worker/src/main.ts       # 后台任务
cd apps/web && NODE_ENV=production node --env-file=../../.env server.ts   # 网页，3000 端口
```

三个进程要一直运行，生产环境用 systemd 或 pm2 守护。

开发时用带热更新的方式：`npm run dev:api`、`npm run dev:worker`、`npm run dev:web`。开发时想免登录进后台，在 `.env` 里设 `DEV_AUTH_ROLE=admin`（生产环境会拒绝启动）。
