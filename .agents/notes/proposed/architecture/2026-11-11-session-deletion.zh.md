# Agent Note: 删除已持久化的 Session

Status: proposed

[English](2026-11-11-session-deletion.md) | 中文

## Problem

目前没有任何产品界面可以删除已持久化的 Session。`SessionPersistence` 只提供 create、open、flush、stat 与 list；JSONL 后端只删除临时文件，Web、SDK 与 ACP 前端都不提供删除。因此 ACP 把 `session/delete` 列为不支持，ACP 或编辑器客户端会累积无法删除的 Session。

删除是破坏性操作，且跨越多个所有者：Session 日志（所有保留的格式代次）、持久化投影缓存、`session-query` 索引以及 ACP 协议界面。它还要与活跃 Session、其他进程以及进行中的读取竞争。

## Proposal

新增 `SessionPersistence.remove(id, options)` 作为存储契约。基类实现抛出带类型的“不支持”错误，使每个后端显式获得删除能力，而不是静默继承某种策略。

JSONL 后端以原子方式删除 Session 目录的所有保留代次：获取 Session 锁，在另一个进程持有时拒绝，把目录重命名到 trash 前缀，再删除重命名后的目录树。崩溃只会留下被忽略的 trash 条目，不会留下 `list` 会复活的半删除 Session。缺失的 Session 报告 not-found；尚未物化的 pending Session 没有产物，也报告 not-found。

所有权规则：

- 当前进程中活跃的 Session（`ctx.sessions.get`）不可删除。
- 本服务持有的写句柄会拒绝删除；读句柄不会阻止删除，但之后会观察到 not-found。
- 由其他进程持有的锁会大声失败，绝不强制删除。
- Subagent Session 随其所属根 Session 一起删除或被拒绝，不单独删除。

跨包清理：

- 日志删除提交后，投影缓存删除该 id 的所有行。
- `session-query` 在新的 `session/deleted` 事件上删除其索引行；错过该事件的后端在下一次 rescan 时删除，因此即使没有索引，删除结果依然正确。
- 附件保留：它们按内容寻址，可能被其他 Session 或仍打开的读取共享。孤立的附件对象由独立的保留任务负责。
- 标题、统计与检查点存放在投影缓存中，随缓存一起消失。

ACP 公布 `sessionCapabilities.delete: {}` 并实现 `session/delete`：校验一个非活跃、非 subagent、工作区匹配的根 Session，调用 `remove`，返回 `{}`。客户端从响应与下一次 `session/list` 得知该 Session 已消失。

## Alternatives considered

**从 ACP 桥直接删除文件。** 不予采用：前端不得拥有存储布局、锁或格式代次；Web 与 SDK 需要同样的能力。

**在 header 上做软删除标记。** 不予采用：所有读取方（list、resume、查询索引、标题缓存）都必须过滤该标记，而且产物仍会增长。

**只删除当前格式代次。** 不予采用：保留的前代文件会在重启后重新成为该 Session。

**随 Session 删除附件对象。** 不予采用：附件按内容寻址且可能共享，所有权不属于单个 Session。

**只通过 `session-query` 执行删除。** 不予采用：查询索引是派生的、可选的；没有它时存储也必须保持正确。

## Open questions

- `session/deleted` 应该作为根日志上的持久 Session 事件（不合适：日志正在被删除），还是由持久化提供方发出的宿主服务事件？后者让存储与索引解耦。
- Web 是否在同一次变更中提供删除，还是先只做 ACP？
- trash 目录树在启动清理前保留多久？
- 删除根 Session 时，是一并删除其 subagent 子会话，还是在仍存在可继续子会话时拒绝？

## Acceptance criteria

JSONL 契约测试覆盖删除所有代次、not-found、其他进程持有、打开的写句柄以及 trash 恢复。投影缓存与 session-query 测试覆盖行删除。ACP 测试覆盖能力公布、成功删除、非活跃要求、工作区不匹配与 subagent 拒绝。免密钥的 recorded snapshot 覆盖 ACP 请求与响应。

## Risks

- 删除不可逆：错误的 id 或过早的 trash 清理会销毁历史。重命名到 trash 是唯一的恢复窗口。
- 跨进程锁竞争可能删除另一个进程刚开始读取的 Session；读取方必须把 not-found 视为有效结果。
- 错过 `session/deleted` 的索引后端在下一次 rescan 之前会返回陈旧行。
- 删除仍有活跃 subagent 子会话的根 Session 会使其后续无法继续；必须先按 child-first 释放再移除产物。

