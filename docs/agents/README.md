# AIHOT 主代理与专业子代理

本项目的长期协作体系是项目文件与工作协议，可随仓库复用。主代理名为 **AIHOT Project Orchestrator**，由根 [AGENTS.md](../../AGENTS.md) 定义；专业角色使用 Codex 原生 TOML，而不是另建一种自定义 Agent 格式。

```text
AIHOT Project Orchestrator
├── aihot-finance-agent  财经业务、Prompt、分类、评分、事件与报告
├── aihot-source-agent   信源、采集解析、正文与材料质量
└── aihot-ops-agent      服务、模型 Provider、队列、数据库与部署运行
```

## 定义与维护位置

| 文件 | 作用 |
|---|---|
| [根 AGENTS.md](../../AGENTS.md) | 主代理身份、架构边界、路由与高风险控制 |
| [finance TOML](../../.codex/agents/aihot-finance-agent.toml) | 财经专用职责与完整 V1 业务规则 |
| [source TOML](../../.codex/agents/aihot-source-agent.toml) | 六类 Source、采集与正文诊断职责 |
| [ops TOML](../../.codex/agents/aihot-ops-agent.toml) | 基础设施、队列、LLM/receipt/budget 与上线职责 |
| [common.md](common.md) | 共用协作、授权、测试、交付格式 |
| [known-state.md](known-state.md) | 带来源与时间的历史状态和已确认决定 |

只在对应文件维护规则，避免把三份角色规则复制到根 AGENTS。已有 `CLAUDE.md` 指向 AGENTS，继续沿用；不改其配置，不创建重复的 Skills、后台服务或全局设置。

## Codex 机制与兼容调用

环境核查日期为 2026-10-02，安装的 CLI 为 `0.159.0`。[OpenAI 官方文档](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents) 定义项目级 `.codex/agents/*.toml`，必需字段为 `name`、`description`、`developer_instructions`；三个角色均采用该格式。

角色不指定模型、推理强度、沙箱或权限覆盖，沿用父代理配置。网站后台 GLM 的配置与 Codex 的运行模型是两回事。主代理直接使用根 AGENTS，不再注册第四个“万能子代理”。

能按自定义角色名调用的客户端优先加载原生定义。当前会话委派工具只接受任务名和任务说明，没有自定义角色类型参数；主代理需读取 TOML 的 `developer_instructions` 及引用文档，将规则和任务边界完整交给临时实例。若连子代理工具也不可用，由主代理依照同样规则处理并说明限制。

新配置若未在当前会话发现，应在同一项目新开对话或重新启动 CLI 会话加载。此创建过程不宣称当前客户端已热加载原生角色，也不自动修改用户全局 config 或权限。后续 Codex 格式变化时先核对当前官方文档和本地版本，再调整。

## 使用方法

可以直接描述任务，由主代理按领域路由，也可指定角色：

```text
请调用 aihot-finance-agent，分析房地产新闻被 BLOCK 的原因，先只读检查。
请调用 aihot-source-agent，检查财联社 Feed 有标题却没有正文的问题。
请调用 aihot-ops-agent，检查 articles 一直处于 new 的原因，先不改生产数据。
```

跨领域任务示例：

| 任务 | 依赖顺序 |
|---|---|
| 财联社抓取失败、材料不足导致判断错误 | source 先查材料，finance 再查业务规则；网络/队列问题交 ops |
| 财经规则修改并上线 | finance 修改并验证，主代理验收及核对部署授权，ops 构建部署并验证 |
| RSSHub 私网访问被 SSRF 拒绝 | source 确认请求与防护，ops 给出网络方案，主代理协调精确允许范围 |

主代理为每步分配文件归属；同一文件先交接再写。检查可并行，依赖步骤和共享数据库测试串行。子代理按 common 的固定格式返回，主代理汇总最终结果。

## 持久化与高风险边界

持久化的是版本化文件，任务实例不会自动记住所有历史对话，也不是后台常驻进程。将这些定义随项目正常纳入 Git 后，其他 checkout 可使用同一规则；不自动 commit/push。新的长期决定由有授权的任务更新到相应文档。

高风险包括破坏性 SQL/删生产分析与回执、删除 volume、`down -v`、强推/hard reset、schema/API/核心队列变更、生产数据写入与付费重评、秘密配置变更及部署。子代理先向主代理交接，主代理核对用户对具体范围的授权；已有授权不重复询问。不读取、打印或提交真实凭据。

代理基础设施的最初阶段只建立本协作体系。当前财经 V1 是用户另行批准的本地开发任务，范围见 [财经 V1](../finance-v1.md)。角色加载本身仍不授权业务修改、生产数据库、`.env` 或部署；隔离假模型验收例外见 common 和根 AGENTS。
