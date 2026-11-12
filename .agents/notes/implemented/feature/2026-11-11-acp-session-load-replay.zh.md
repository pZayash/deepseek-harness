# Agent Note: ACP session/load 回放已提交历史

Status: implemented

[English](2026-11-11-acp-session-load-replay.md) | 中文

## Problem

桥接层公布了 list、resume、close 与 fork，却缺少标准方法 `session/load`。客户端用 `session/resume` 重新打开持久会话时只能得到空的 transcript：resume 会恢复 Agent 与配置，但刻意不发送历史。因此编辑器客户端在重新打开会话时丢失对话，自动化边界也把 `session/load` 列为不支持。

## Decision

`initialize` 公布 `loadSession: true`。`session/load` 校验一个已持久化且非活跃的根会话（非 subagent、规范工作区匹配、没有活跃所有者），通过持久化层读取其完整日志，经由与 resume 相同的路径组合 Agent，把可见对话作为标准 `session/update` 通知回放，排空该会话的更新链，然后才返回完整配置选项。

回放遍历 `Session.surface.nodes`，因此被压缩或被替换的范围只贡献其替换内容。人类撰写的用户与助手文本和图片映射为 `user_message_chunk`／`agent_message_chunk`；面向模型的 user-role 上下文（运行时快照、开发者指令、压缩摘要）与助手 reasoning 被跳过。工具生命周期复用与实时交付相同的 `toolCallUpdate`／`toolResultUpdate` 投影，保留每次调用的已提交名称与参数以补全结果卡片。最近一次已提交的 `todo/write` 作为一次替换 `plan`。usage 被省略，因为它属于实时轮次的遥测。历史图片不可用时记录警告并跳过，而不是让整个加载失败。

读取完整日志是一次显式的存储读取，符合[完整历史规则](../architecture/2026-09-09-deprecate-synchronous-session-event-reads.zh.md)；回放只向客户端发送，不追加任何事件。

## Alternatives considered

**回放原始已提交事件。** 不予采用：压缩或 surface 替换之后，被遮蔽的原始事件会重新出现在客户端。

**回放 `deriveMessages()`。** 不予采用：派生消息丢失工具调用身份和生成标准卡片的工具自有 render intent；从助手内容重建调用会重复投影逻辑。

**在回放中包含 reasoning 与 usage。** 不予采用：两者描述实时轮次而非对话历史，并且会让大型会话淹没客户端。

**暴露历史分页。** 不予采用：ACP 没有分页方法；`session/load` 是标准历史界面，回放范围由可见对话限定。

**允许加载活跃会话。** 不予采用：第二个写入方或观察方会与实时更新链竞争并重复交付。

## Consequences

客户端重新打开会话时会带回对话、工具卡片与当前计划。加载成本随可见历史与一次完整日志读取增长。工具卡片使用当前注册表：录制之后被移除的工具会回退到通用卡片。历史图片依赖持久附件存储，并退化为省略。reasoning 与上下文用量不会重新出现在客户端。

## Related decisions

[ACP 仅自动化协议](../simplification/2026-07-23-acp-automation-only-protocol.zh.md)负责自动化边界；[由已提交 render intent 派生的标准 ACP 词汇](2026-11-04-acp-standard-presentation-vocabulary.zh.md)负责本回放复用的卡片投影；[在单连接上多路复用并发 ACP 会话](../../archived/feature/2026-06-14-acp-multi-session.zh.md)负责每会话隔离。
