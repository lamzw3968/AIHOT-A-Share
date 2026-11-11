# 模型配置、共享配额与评测保护

本文按 2026-10-15 的实现说明 `default`、命名预设、百灵 `Ling-3.1-flash` 及恢复边界。配置示例只描述设置方式，不授权真实模型调用、生产迁移或历史重评；真实账号权限、供应商限额、响应协议及质量需在上线前单独确认。界面打开和后台模型查询只读配置、统计与已保存报告，不发起付费模型请求。

## 模型名称与 11 项能力

能力配置选择的是注册预设键；预设键、实际 API 型号、显示的 Provider 和预算服务名称可能不同。例如 `glm-5.3-flash-selection` 是高推理评分预设，实际 API 型号仍为 `glm-5.3-flash`；`default` 是部署配置的别名，不是供应商型号。

| 预设键 | 实际 API 型号 | 端点 / Key 环境变量前缀 | 预算 service |
| --- | --- | --- | --- |
| `default` | `LLM_MODEL` | `LLM` | `llm` |
| `ling-3.1-flash` | `Ling-3.1-flash` | `ANT_LING` | `llm` |
| `glm-5.3-flash` | `glm-5.3-flash` | `ZHIPU` | `zhipu` |
| `glm-5.3-flash-selection` | `glm-5.3-flash` | `ZHIPU` | `zhipu` |
| `deepseek-flash` | `deepseek-flash` | `DEEPSEEK` | `deepseek` |
| `deepseek-flash-think` | `deepseek-flash` | `DEEPSEEK` | `deepseek` |
| `qwen3.7-flash` | `qwen3.7-flash` | `DASHSCOPE` | `dashscope` |
| `qwen3.8-flash` | `qwen3.8-flash` | `DASHSCOPE` | `dashscope` |
| `qwen3-vl-flash` | `qwen3-vl-flash` | `DASHSCOPE` | `dashscope` |
| `mimo-v2.6-flash` | `mimo-v2.6-flash` | `XIAOMI_MIMO` | `mimo` |

表中前缀分别对应 `<前缀>_BASE_URL` 和 `<前缀>_API_KEY`。命名预设需要对应端点和 Key；除下文的严格 Ling 回退外，不会自动借用 `LLM_*`。这是本项目的注册清单，不表示供应商当前向每个账号提供全部型号。`qwen3-vl-flash` 是图像预设，后台仍执行现有能力与预设的 vision 匹配校验；Ling 命名预设为文本模型。

| 能力 | 环境变量 | 用途 |
| --- | --- | --- |
| `prefilter` | `PREFILTER_MODEL` | 行业预筛 |
| `score` | `SCORE_MODEL` | 两次独立精选评分 |
| `understand` | `UNDERSTAND_MODEL` | 内容理解与入选标题摘要 |
| `summarize` | `SUMMARIZE_MODEL` | 其他内容的标题摘要 |
| `structure` | `STRUCTURE_MODEL` | 分类、标签、主体和事实结构 |
| `group` | `GROUP_MODEL` | 事件归组与合并判断 |
| `groupReview` | `GROUP_REVIEW_MODEL` | 归组与合并复核 |
| `digest` | `DIGEST_MODEL` | 事件综述 |
| `report` | `REPORT_MODEL` | 日报、周报、月报 |
| `translate` | `TRANSLATE_MODEL` | 正文及引用翻译 |
| `monitor` | `MONITOR_MODEL` | Codex 重置公告识别 |

这 11 项能力保留原有优先级：**有效的后台覆盖 → 能力环境变量 → 代码默认 `default`**。后台“恢复环境配置”只删除该能力的覆盖；环境变量未配置或名称无效时回到代码默认。后台切换写入审计并使当前进程的模型缓存失效；其他进程最多经过原有约一分钟的缓存周期观察覆盖变更。选择新模型影响之后的调用，不自动重评已保存内容。

端点和 Key 使用后端凭据读取器：进程环境变量优先，未提供时可读取 `AIHOT_CREDENTIALS_DIR` 下的 `models.env`。`LLM_MODEL`、能力选择、JSON 参数和 `ANT_LING_*` 限流参数直接读取进程环境；不要假设把这些参数只写入分组凭据文件就能生效。进程已经加载的环境及分组凭据缓存变更需要重建或重启相应进程，具体步骤见[部署](deploy.md)。

后台列表保留预设键、service 和 vision 字段，并显示实际型号、Provider 与别名标签；例如 `default → Ling-3.1-flash (ant-ling)`。未知自定义网关通常显示 `openai-compatible`。该标签用于识别配置，不证明端点已连通或账号有权限。接口不返回 Key、端点、请求 extras 等秘密配置。

## 配置 Ling

### 作为默认模型

在已获授权的目标环境中，用以下值替换对应配置；Key 留空表示尚未配置：

```dotenv
LLM_BASE_URL=https://api.ant-ling.com/v1
LLM_API_KEY=
LLM_MODEL=Ling-3.1-flash
LLM_EXTRA_JSON={}
```

没有能力覆盖时，各能力经 `default` 调用该模型。改用 Ling 前必须清除 DeepSeek、GLM 或 Qwen 的 `thinking` / `reasoning` 等特有参数；`.env.example` 原默认示例的 DeepSeek 参数不能原样带入 Ling。

### 作为独立命名预设

```dotenv
ANT_LING_BASE_URL=https://api.ant-ling.com/v1
ANT_LING_API_KEY=
ANT_LING_EXTRA_JSON={}
# 只改变需要的能力；后台已有覆盖仍优先。
# SUMMARIZE_MODEL=ling-3.1-flash
```

独立端点和 Key 不依赖其他厂商的 `LLM_*`。只配置其中一项会在付费准入前报配置错误，不拼接独立地址与其他厂商的 Key。

只有 `ANT_LING_BASE_URL` 和 `ANT_LING_API_KEY` **都未配置**，且 default 的实际型号为目标 Ling、端点精确规范化到 `https://api.ant-ling.com/v1/chat/completions` 时，命名预设才可以复用 default 的地址与 Key。该回退同时允许继承 `LLM_EXTRA_JSON` 和 `LLM_JSON_MODE`；显式 `ANT_LING_EXTRA_JSON` 优先。独立配置下，命名 Ling 不继承默认模型的 extras 或 `LLM_JSON_MODE`。自定义网关即使使用同一型号，也不满足官方 default 回退条件，需要成套独立配置。

项目仅为 `Ling-3.1-flash` 应用 Ling 兼容分支，型号识别不区分大小写并统一 API 型号拼写。它接受官方 `/v1` 或完整 `/v1/chat/completions` 地址，去除多余尾斜线且不会重复追加路由；官方地址要求 HTTPS、无非默认端口，不能包含用户名、密码、query 或 fragment。Ling 指向智谱官方端点会被拒绝；官方 Ling 端点上的其他 Ling / Ring 型号不在本次支持范围。其他 HTTP(S) 网关只接受同样的 URL 结构校验，其真实兼容性没有由本地测试证明。

## 官方资料核对与账号验证边界

2026-10-14 仅查阅公开文档，未登录账号或调用模型：[OpenAI 接口](https://developer.ant-ling.com/zh-CN/docs/api-reference/openai/)列出 `Ling-3.1-flash`、`/v1/chat/completions` 与同步 `choices[].message.content` 响应；[结构化输出](https://developer.ant-ling.com/zh-CN/docs/tutorials/structured-outputs/)提供 `json_object` 示例。[调用限制](https://developer.ant-ling.com/zh-CN/docs/api-reference/queries-per-second/)当时写明 2 QPS、同步调用 90 秒超时；项目默认仍为保守的 1 QPS / 1 在途及最多 85 秒 HTTP 超时，不按公开数字自动提高配置。

这些页面不是本部署账号的服务承诺，也没有给出可据此配置的账号 TPM 数值。本项目未接入 TPM 或余额查询；真实 Key 的权限、共享限额范围、输入/输出 token 上限、免费额度到账与计费、JSON/schema 质量及网关行为仍待获授权验证。不要将文档示例中的 token 默认值、上下文长度或本项目的 4096 配置当成账号保证。项目当前只实现非流式调用，不因供应商推荐流式而自动切换协议。

## Ling 请求和响应参数

| 参数 | 当前行为 |
| --- | --- |
| 输出额度 | `ANT_LING_MIN_OUTPUT_TOKENS` 默认 `4096`，必须为正安全整数；未显式覆盖时取调用额度（未指定时 1500、至少 512）与该值的较大者，保留更大任务额度 |
| 显式 `max_tokens` | 有效的 extras 值优先，允许低于上述默认下限；必须为正安全整数，代码没有猜测供应商专属输出上限 |
| temperature | 调用默认 `0.2`，extras 可覆盖；Ling 兼容层要求 `0` 至 `1` |
| top_p | 若显式提供，必须大于 `0` 且不超过 `1` |
| HTTP 超时 | 不超过 `85,000ms`，调用方指定更短超时仍保留；这是项目保护值，不是供应商 SLA |
| JSON 模式 | 默认请求 `response_format: {"type":"json_object"}`；调用的 `json:false` 可使用文本和已有 parser，冲突的 extras 会报错 |
| 保留字段 | extras 不得覆盖 `model`、`messages`、`stream` |
| 推理开关 | 拒绝未经确认的 `thinking`、`reasoning`、`reasoning_effort`、`enable_thinking`、`thinking_budget`，不从 GLM 复制参数 |

最终请求仍走 OpenAI-compatible `messages`，响应读取 `choices[0].message.content`、`finish_reason`、`usage` 和响应 ID。原响应先经回执保存，再进行 JSON / 自定义 parser 与 schema 校验。`finish_reason=length`、空/缺失/非字符串最终内容、无效 JSON 或 schema 不匹配均失败；不会用 `reasoning_content` 顶替最终答案、补问、切换模型或在同次 `chatJson` 中隐藏重发。HTTP 成功但输出不可用时，收到响应的 attempt 证据保留，逻辑回执标失败；之后的显式再次尝试仍受原预算与回执规则约束。

GLM 实际型号识别、low/high 推理预设、输出额度、HTTP 参数、缓存身份及输出校验保留原有分支。Ling 的 QPS、租约和 Retry-After 处理只接入实际 Ling 型号；现有 GLM、DeepSeek、Qwen、MiMo 调用不会因为设置 `ANT_LING_*` 而使用 Ling 配额。

Ling 的有效请求 `bodyHash` 纳入缓存身份，因此输出额度或 JSON 协议变化可能形成新身份；QPS、并发数、Quota 分组及凭据/端点变化本身不会强制刷新缓存。逻辑身份仍包含 service、purpose、model 和 attemptTag，不能靠更换 tag 绕过 unknown。需要重新评测时先核对已有回执及独立费用授权。

## 共享配额、预算与回执

```dotenv
# 项目默认值；不是从真实账户读取的限额。
# ANT_LING_QPS=1
# ANT_LING_MAX_INFLIGHT=1
# ANT_LING_MIN_OUTPUT_TOKENS=4096
# ANT_LING_QUOTA_GROUP=
```

`ANT_LING_QPS` 必须为正有限数，按 `ceil(1000/QPS)` 毫秒设置准入间隔；`ANT_LING_MAX_INFLIGHT` 必须为正安全整数。默认 1 QPS、1 个在途请求。已知请求完成后还会保守延后下一次准入，所以配置 QPS 表示上界，不保证达到该吞吐量。并发租约长度为本次 HTTP 超时加 15 秒。

跨进程共享状态在 PostgreSQL 中协调。同端点与同 Key 的 default / 命名别名使用同一个非明文配额键。`ANT_LING_QUOTA_GROUP` 可将同账户的多个 Key 或端点显式合为一组；组名应为非秘密标识。所有同组进程必须访问同一数据库并使用一致的 QPS、并发和分组设置，不同数据库不能共享额度。同一组不能混跑绕过配额的旧实现。Key 本身不写入配额键或后台查询结果。

配额只管理请求间隔、在途并发与 429 冷却，**未实现 TPM、token 日额度、字符额度、账户余额或金额预算**。原预算按 `receipt_attempts` 的服务及 live 请求次数统计滚动一分钟、一小时、24 小时，包括同一逻辑请求的重新尝试；不是自然日 token 预算。Ling 的 default 和命名预设都计入已有 `llm` 服务预算，不新增可绕过历史消费的新桶。default 使用 GLM 时也仍属于 `llm`，命名 GLM 属于 `zhipu`，不要把 Provider 标签当成预算 service。

原预算的任何窗口值小于等于零会暂停该 service；若相应预算行被移除，原实现视为不限请求次数。上线应确认预算行及阈值存在，不能用删除预算行的方法“恢复”模型。

| 情况 | 处理及付费证据 |
| --- | --- |
| 已收到/完成的同身份缓存 | 复用保存响应，不新增 HTTP、attempt、预算或 quota 准入 |
| 请求未发送且配额不足 | 准入事务回滚，不创建付费 attempt；在事务外允许少量短等待，仍不足则抛 `ProviderDeferredError` |
| 预算耗尽 | HTTP 前抛 `BudgetExceededError`，不创建本次付费 attempt；评测停止，生产任务继续按原有预算失败策略处理 |
| 已发送且收到 429 | 保留真实失败 attempt 和请求次数预算；同组共享冷却，真实 429 不伪装成未发送等待 |
| HTTP 超时、发送后断连或未知结果 | 保留 unknown 回执与 attempt，租约保守保留至到期；租约到期只释放准入容量，不允许绕过 unknown 重发 |
| 同一逻辑请求仍在执行 | 保持 busy 保护，其他调用方不得启动重复付费请求 |

Ling 429 支持有效的 `Retry-After` 秒数（向上取整）或 HTTP 日期；无效值使用带少量抖动的 30 秒起步指数冷却，最多 300 秒。有效的供应商提示不被该 300 秒回退上限截断；共享冷却只会延长，不被较短提示缩短。HTTP 本身不跨数据库事务持锁，也不因冷却自动重发。

`ops.recover` 将陈旧 `pending` 标为 `unknown`，**unknown 不因超过 30 分钟、租约到期或 Worker 重启而自动允许重发**。租约到期只释放准入容量，不能证明原请求未被接受或未计费。兼容入口 `autoReleaseUnknownReceipts` 保留返回形状，但始终返回 `released: 0, requeued: 0`；旧版本留下的自动放行标记也不能替代当前人工授权。Quota、Deferred 和评测不提供旁路。

管理员在后台“运行”页按 `receiptId` 核对供应商请求与账单，选择是否计费、填写必需说明，再执行“记录并放行”。这个现有动作同时记录核账结论和**授权重新发送**，并不是只记账：回执由 `unknown` 变为可再次尝试的 `failed`，`receipt.release` 审计记录操作者、说明、`billed`、`resendAuthorized` 和恢复结果；历史 attempt 仍保留 `unknown`。人工结论不能保证供应商实际未收费，选择已计费后放行明确接受再次计费风险。之后的处理仍经过回执、预算与 Quota，不立即保证业务完成；若再次 unknown，需要再次人工核对授权。不要通过删回执、清配额表、换 attemptTag 或反复运行评测绕过保护。

发送后断连、响应编码/保存失败会以不携带原始凭据或 cause 的 `ReceiptUnknownError` 关联 `receiptId`，Worker 据此关联失败任务并等待核对。数据库故障可能使状态暂留 `pending`；有并发响应已成功提交时不降级已保存结果。人工授权后，文章按既有处理流程重新排队；关联失败的 pg-boss 任务及 Deferred 续任务受原期限约束，过期旧任务不复活，不能将该期限保证泛化为文章新任务继承旧期限。因 unknown 失败且零剩余原生重试的队列任务，也只能在明确授权后获得受控恢复机会。未发送的 Quota 等待不属于 unknown，仍按下节 Deferred 规则自动恢复。

## 延期恢复与已知边界

0043 迁移新增 `provider_quotas`、`provider_quota_leases`、`provider_deferred_jobs`；不改写原业务和回执数据。迁移、安全备份及回滚检查见[部署](deploy.md)。

文章的未发送等待使用既有 `processing_retry_at`，不增加 `processing_attempts`，由五分钟一次的 `content.sweep` 恢复。其他能够向上传递 `ProviderDeferredError` 的业务/cron 任务，在同一短事务中写入延期记录并完成原队列任务；每分钟的 `providers.resume` 检查到期记录，再经 pg-boss 公共 API 投递。只设置模型配置、只启动 API 或只打开后台不会运行这些 Worker 调度。

恢复保存原 payload（含已有 `attemptTag`）、priority、singleton key、剩余失败额度、原始绝对期限和报告日期，以及已有 group、heartbeat、dead-letter 等选项。行锁 `FOR UPDATE SKIP LOCKED` 与发送/指针更新的同事务防止多个 dispatcher 重复认领同一延期记录。队列不可用、singleton 冲突或派发异常会保留诊断并稍后重查；过期任务不执行，完成/失败/取消/缺失任务进入诊断终态。终态延期协调证据在原期限结束一周后限量清理，不删除回执或业务数据。

必须保留以下验收边界：

- continuation 是新建的 pg-boss 任务，原生 `retryCount` 从零开始，指数退避阶段可能重置；保存的是剩余失败额度，不能宣称完整保留原退避曲线。
- 当前项目不使用时间桶 singleton；遇到 `singletonOn` 的任务不能安全复原时间窗，会明确拒绝停车。
- dispatcher 锁与回执幂等降低重复风险，不能据此承诺网络调用或业务执行 exactly once。丢失队列任务会留诊断，不能因“任务缺失”盲目再投递已可能付费的工作。
- 事件主归组之后的辅助 `consolidate` 仍是 best effort，独立持久恢复尚未纳入这次迁移；不能将主归组成功等同于辅助合并全部完成。
- 到期租约在后续同组准入时清理；停用账户的残留租约没有新增周期清理任务，不应为此扩大为清库操作。

## 评测中断与 SelectBench

Gold Set 格式与评分方法见[精选与校准](selection.md)。运行评测可能产生付费请求；只在明确授权的环境与费用范围内使用，离线验收使用隔离数据库和 loopback Mock。

`scripts/eval-selection.ts` 遇到配额等待、429、预算耗尽、Provider 拒绝、busy / unknown 回执或其他运行异常时，停止新样本、新评分链及下一模型。已经启动的任务和双评分链安全排空；因此中断后仍可能出现已启动链的第二次评分，不能承诺“遇到第一个 429 后再无 HTTP”。脚本不会取消已发送请求或释放 unknown。

报告统一写入 `config.dataDir/eval`：未设置 `AIHOT_DATA_DIR` 时为源码根目录的 `.data/eval/`，Compose 已配置 `/data` 持久卷，报告因此位于 `/data/eval/`。相对 `AIHOT_DATA_DIR` 按 CLI 的工作目录解析；`--gold` 的相对路径仍按源码根目录解析，改变输出目录不会搬迁输入样本。脚本在任何模型请求前创建目录并实际创建、写入、关闭、删除探测文件；不可写时明确报错并发送 **0 次模型请求**。预检后磁盘空间、权限或挂载仍可能变化，最终保存失败时不能保证产生报告。旧报告不自动搬迁，现有备份不包含 `eval/`；见[部署说明](deploy.md#隔离-docker-验收)。

中断报告的 `meta` / 模型 summary / 未完成 case 明确记录 `incomplete`、`deferred`、`unstarted` 或 `pause`；所有模型的准确率、precision、recall、F1 及相关比率均为 `null`，阈值 sweep 为空。即使较早模型已经完成，整个不完整比较也不得用于排名。保存成功后跳过自动导入并以退出码 `2` 结束；目录预检或最终保存失败则异常退出。非法并发数、样本数、重复模型或空样本在请求前拒绝，不产生有效质量报告。

自动和后台手工导入统一经过 SelectBench 校验，拒绝任何层级的中断标记、显式空质量指标、零样本、不匹配模型覆盖，以及已提供 case 列表的不完整覆盖、重复 ID 或跨模型 ID 集不一致；后台返回 400，校验前不写入 run、result 或导入审计。

合法历史 `{meta, models}` 与按模型键组织的旧报告继续支持，也允许未提供 case 列表的历史 summary-only 报告。提供的样本量必须是相同的正整数；提供的质量指标必须为 0 至 1 的有限数字。只要明确提供 case 列表，就必须覆盖完整样本；缺少最终 decision 的 case 必须有有效的错误说明。已收到回答但 JSON/schema 不可用的 `ModelOutputError` 仍是完成尝试的质量错误：保存 `errors` 与错误 case，继续原有退出码 `0` / 合法导入语义，不把所有质量错误误报为配额中断。

历史 summary-only 报告缺少逐 case 证据，校验无法据此证明它过去是否中断；不得去掉 `incomplete` 或 case 列表来伪造完整报告。本次保护不回删或重算数据库中既有 SelectBench 历史记录。缓存重跑的 usage 汇总相关回执全部历史 attempts，不代表本次新增消费；费用或质量结论仍需相应账单与人工标注证据。

## 上线前核对

1. 确认运行 revision、迁移账本及 0043 表结构；有同名表、编号或账本冲突时停止核对，不用 `IF NOT EXISTS` 或清表掩盖冲突。
2. 按[部署](deploy.md)备份数据与附件、安排停旧 Worker、迁移和接管；同组进程使用同库同参数，回滚保留延期表、unknown 和回执证据。
3. 核对后台覆盖、能力环境变量、default / 命名预设、真实端点和账号权限。只报告凭据配置状态，不把 Key、真实 `.env`、连接串或后台原始配置放入日志、报告或 Git。
4. 核对真实 QPS / 并发 / 输出限制、token 与金额上限及成本；项目保守默认和 Mock 成功不能替代供应商账号控制台或获授权的真实验证。
5. 保留原 GLM 13 项、Ling、Quota、Receipts、Deferred、后台与评测回归；测试用独立 `_test` / `_ci` 数据库，开发/普通测试显式关闭采集、真实模型、飞书和 IndexNow。隔离 Mock 模型通路仅按既有测试例外受控开启。
6. 分别验收响应 schema、回执与业务结果、延期恢复以及公开 publication 链路；HTTP 200、后台标签或模型开关为 true 都不等于完整业务成功。真实 Provider 质量、账户配额、生产部署和历史重评需单独确认。

实现依据：[模型 registry](../packages/backend/src/providers/llm.ts)、[Ling profile](../packages/backend/src/providers/model-profile.ts)、[能力路由](../packages/backend/src/editorial/models.ts)、[共享配额](../packages/backend/src/providers/provider-quotas.ts)、[回执](../packages/backend/src/providers/receipts.ts)、[延期恢复](../packages/backend/src/jobs/provider-deferred.ts)、[调度器](../apps/worker/src/schedules.ts)、[评测脚本](../scripts/eval-selection.ts)、[SelectBench 导入校验](../packages/backend/src/admin/selectbench.ts)。
