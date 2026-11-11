# Agent Note: 删除已持久化的 Session

Status: implemented

[English](2026-11-11-session-deletion.md) | 中文

## Problem

目前没有任何产品界面可以删除已持久化的 Session。`SessionPersistence` 只提供 create、open、flush、stat 与 list；JSONL 后端只删除临时文件，Web、SDK 与 ACP 前端都不提供删除。因此 ACP 把 `session/delete` 列为不支持，ACP 或编辑器客户端会累积无法删除的 Session。

删除是破坏性操作，且跨越多个所有者：Session 日志（所有保留的格式代次）、持久化投影缓存、`session-query` 索引以及 ACP 协议界面。它还要与活跃 Session、其他进程以及进行中的读取竞争。

## Decision

新增 `SessionPersistence.remove(id, options)` 作为存储契约。基类实现抛出带类型的“不支持”错误，使每个后端显式获得删除能力，而不是静默继承某种策略。

JSONL 后端以原子方式删除 Session 目录的所有保留代次：获取 Session 锁，在另一个进程持有时拒绝，把目录重命名到 trash 前缀，再删除重命名后的目录树。崩溃只会留下被忽略的 trash 条目，不会留下 `list` 会复活的半删除 Session。缺失的 Session 报告 not-found；尚未物化的 pending Session 没有产物，也报告 not-found。

所有权规则：

- 当前进程中活跃的 Session（`ctx.sessions.get`）不可删除。
- 本服务持有的写句柄会拒绝删除；读句柄不会阻止删除，但之后会观察到 not-found。
- 由其他进程持有的锁会大声失败，绝不强制删除。
- Subagent Session 随其所属根 Session 一起按 child-first 删除；独立的 subagent Session 不可删除。

跨包清理：

- 日志删除提交后，投影缓存删除该 id 的所有行。
- `session-query` 可以在 `session/deleted` 事件上删除其索引行；在它订阅之前，下一次 rescan 会修复派生索引，因此没有索引时存储删除依然正确。
- 附件保留：它们按内容寻址，可能被其他 Session 或仍打开的读取共享。孤立的附件对象由独立的保留任务负责。
- 标题、统计与检查点存放在投影缓存中，随缓存一起消失。

`session/deleted` 是由持久化提供方在产物消失后发出的宿主服务事件，绝不是 Session 日志事件：日志正是被删除的对象。ACP 公布 `sessionCapabilities.delete: {}` 并实现 `session/delete`：拒绝活跃成员，校验非 subagent 根会话，按 child-first 删除全部已持久化后代，并返回 `{}`。

## Alternatives considered

**从 ACP 桥直接删除文件。** 不予采用：前端不得拥有存储布局、锁或格式代次；Web 与 SDK 需要同样的能力。

**在 header 上做软删除标记。** 不予采用：所有读取方（list、resume、查询索引、标题缓存）都必须过滤该标记，而且产物仍会增长。

**只删除当前格式代次。** 不予采用：保留的前代文件会在重启后重新成为该 Session。

**随 Session 删除附件对象。** 不予采用：附件按内容寻址且可能共享，所有权不属于单个 Session。

**只通过 `session-query` 执行删除。** 不予采用：查询索引是派生的、可选的；没有它时存储也必须保持正确。

## Consequences

删除不可逆；重命名到 trash 是唯一的恢复窗口，崩溃只会留下被忽略的 `.trash` 条目，而不会留下可复活的 Session。跨进程锁竞争可能删除另一个进程刚开始读取的 Session，因此读取方把 not-found 视为有效结果。投影缓存会丢失被删除树的标题、统计与检查点；`session-query` 在订阅 `session/deleted` 或 rescan 之前会返回陈旧行。附件作为共享的内容寻址对象保留。ACP 按 child-first 删除根及其后代，并在任一成员活跃时拒绝。

验证：持久化删除契约覆盖从 stat/list/open 中成功移除、缺失与未物化 Session 的 not-found、以及活跃写句柄的拒绝；JSONL 套件覆盖发出的 `session/deleted` 事件；ACP 测试覆盖成功删除、活跃拒绝与后代删除。免密钥 recorded snapshot 与此前 ACP 场景一样，因 Windows 检出限制而延后。

