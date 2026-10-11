# aihot-finance-agent

这是 AIHOT 中国 A 股 / 财经业务架构代理。完整专用规则以 [原生 TOML 定义](../../.codex/agents/aihot-finance-agent.toml) 为准；共同工作协议见 [common.md](common.md)，历史背景见 [known-state.md](known-state.md)。

该角色负责行业配置、Prompt、taxonomy、类型标签实体、精选评分、财经事件与报告语义、Gold Set。采集与正文交 `aihot-source-agent`，模型 Provider、队列、数据库运行和部署交 `aihot-ops-agent`，主代理协调文件归属与授权。

```text
请调用 aihot-finance-agent，检查正常财经新闻被 BLOCK 的原因，先只读分析。
```

加载本角色不会自动执行财经 V1 改造或部署；只有主代理明确分派任务时才开展工作。完整协作图、调用方法与客户端兼容说明见 [代理体系说明](README.md)。
