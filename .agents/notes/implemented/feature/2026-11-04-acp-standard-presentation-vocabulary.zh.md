# Agent Note: 由已提交 render intent 派生的标准 ACP 词汇

Status: implemented

[English](2026-11-04-acp-standard-presentation-vocabulary.md) | 中文

## 问题

[ACP 仅自动化边界](../simplification/2026-07-23-acp-automation-only-protocol.zh.md)按字面把边界画在已提交语义事实上，排除了全部展示信息：每个工具调用到达 wire 时只有工具名作 title、`kind: 'other'`，没有 locations、diff 或工具撰写的内容；`session/request_permission` 只携带裸调用 id，`initialize` 硬编码版本 `0.0.1`。图形化 ACP 客户端因此只能渲染通用行和没有信息量的权限提示。由于该排除是字面化的——甚至拒绝了正确构建的 render-intent 桥接——恢复其中任何一部分都需要明确决定哪些展示内容属于自动化传输层。

## 决策

重新划定的边界：由已提交会话事实和纯工具自有 render intent 派生的标准 ACP 词汇进入 wire；DSH 私有展示、客户端能力特性以及未提交数据仍然排除在外。先前的说明保留仅自动化决策；本说明取代其针对标准字段的排除清单。

`toolCallUpdate(ctx, agent, event)` 解析 `ctx.get('tools')?.get(name, agent)?.presentCall(args)`——与 Host presenter 和 Web 卡片消费的同一个纯 render-intent seam——并把带标签的 `ToolCallView` 映射到标准 `ToolCall` 字段：所有卡片使用 view 的 title；`kind` 取通用卡片声明值，terminal 卡片为 `execute`，diff 卡片为 `edit`；`locations` 中的模型面向路径相对于 `session.header.cwd` 解析，因为 ACP 文件路径按文档要求为绝对路径；`rawInput` 取通用卡片声明的显著输入，否则为已提交参数；卡片撰写的文本映射为 `content` 条目；diff 卡片的 `FileDiff` 以同样的绝对化规则映射为 `{type:'diff'}` 内容条目。参数 JSON 畸形、缺少注册表／定义／意图，或 presenter 抛错时，一律回退到通用卡片：以工具名为 title、`kind: 'other'`、参数取解析结果或原始字符串。调用卡片内容只映射文本块，因为该投影必须同步完成。

同一投影对象在 `tool/call` 提交时同步存入每会话 `Map<callId, ToolCall>`，在 `tool/result` 时按调用删除，并在 `turn/end` 时整体清空，以处理无结果的中止调用。`tool/call` 先于 `pipeline.prepare` 与 `approval/request` 提交，且 `session/event` 观察者是同步执行的，因此 `session/request_permission` 总能嵌入与实际发出完全一致的 ToolCall；无法解析的调用 id 仍保留 `{toolCallId}` 的裸回退。一次性 `allow-once` 保持为第一个选项，因为客户端的选项顺序属于 wire 契约。

`initialize` 通过 `fileURLToPath` 从相对 `import.meta.url` 的 `../package.json` 读取 `agentInfo.version`——可执行文件的虚拟文件系统只拦截字符串路径，不拦截 URL 参数——并按语义化版本校验；版本不可读或非法时插件加载失败。`../package.json` 在 `src/` 与 `lib/` 下都能解析到包根。

`@deepseek-ai/dsh-tools` 是可选 peer 依赖：没有注册表的组装保留通用卡片，与 `permissionPresets`／`tokenMeter` 的可选服务模式一致。

所有字段都由已提交的 `tool/call` 事实及其纯函数派生，因此 model-visible⟺logged 保持不变，本变更不需要新的会话事件、格式版本或投影。

## 考虑过的替代方案

**继续字面排除全部展示字段。** 不予采用，因为它把标准协议词汇与 UI 特性混为一谈：`ToolKind`、`locations`、`diff` 内容和完整的权限 `toolCall` 本来就是 ACP 自有词汇，而 render intent 是纯工具自有投影，不是桥接层自有的展示策略。该排除针对的耦合——自动化传输层绑定编辑器约定——并不适用于协议自身定义的字段。

**硬编码工具名→kind 表。** 不予采用，因为 render-intent seam 已经拥有逐工具展示职责，硬编码表会与工具本身漂移。

**客户端能力特性。** 在不变的边界上仍不采用：ACP `terminal` 内容和 `terminal/*` 方法会把执行委派给客户端，因此 shell 输出保持文本；提交前流式更新仍不采用，因为 ACP 无法撤回已发出的分片。

**用配置开关门控这些字段。** 不予采用，因为新增字段是标准词汇，对自动化消费者严格可叠加；`dsh-subagent-acp` 在已读字段之外只多读取 `toolCall.kind`。

## 结果

图形客户端可以渲染有意义的工具卡片与权限提示，支持文件跟随和调用时 diff；自动化消费者只收到严格叠加的字段。桥接层成为工具 render-intent seam 的可选消费者，每个会话只保留一个有界的在途调用投影映射。调用时 diff 由调用参数派生，因此新建的 `oldText` 为 `null`；结果时 diff、更丰富的结果内容、计划更新和 terminal 卡片仍不进入 wire。
