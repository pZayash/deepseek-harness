---
description: "面向希望在 harness 模型选择器中使用 Devin 模型的用户、以及把 ACP agent 接入为 LLM 路由的维护者的 Devin ACP 模型提供方。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-devin-acp

[English](README.md) | 中文

## 概述

使用本包可在 harness 会话中运行 Devin CLI 提供的模型。它注册一个 LLM 提供方，其模型目录从 Devin ACP agent 实时读取，因此模型选择器只显示当前登录账号真正可选的模型。每个 harness 会话拥有一个长期存活的 Devin 进程：提供方转发对话文本，由 agent 用自己的工具规划、编辑并执行命令，然后把最终回答记录为该步骤的助手消息。当工作应由 Devin 完成并通过 harness 观察时选择它；当 harness 必须自己执行工具时，请选择 harness 自带的提供方。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

只要组织已经提供 `llm` 服务与子进程 seam，即可挂载本提供方。`devin acp` 是完整的 ACP agent 服务端，因此唯一必需的配置是可执行文件。

```yaml
- id: llm-devin
  name: '@deepseek-ai/dsh-llm-devin-acp'
  config:
    providerName: devin
    command: C:\Users\me\AppData\Local\devin\cli\bin\devin.exe
    permission: allow
```

提供方路由以 `devin` 出现在模型选择器中，并带有其实时模型列表，会话可选择任一已发布的模型。

### 何时选择

当应由 Devin agent 承担工作时选择本提供方：它维护自己的上下文、编辑文件并在配置的目录中执行命令，而 harness 会话记录它的回答。当模型必须调用 harness 工具、遵守 harness 权限或将 harness 工具活动写入会话时，请选择 harness 提供的模型提供方；本提供方从不发出工具调用，因为 agent 执行的是自己的工具。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `devin` | 提供给模型选择器的提供方路由 |
| `displayName` | `Devin` | 人类可读的提供方名称 |
| `command` | 必填 | Devin 可执行文件 |
| `args` | `['acp']` | 传给 `command` 的参数 |
| `env` | `{}` | 在凭据清理后的父环境之上叠加的 agent 环境变量 |
| `cwd` | harness 进程目录 | 每个 agent 进程与会话的工作目录 |
| `permission` | `reject` | 自动应答 agent 的权限请求：拒绝，或选择第一个 `allow_once`/`allow_always` 选项（`allow`） |
| `modelConfigId` | `model` | agent 未发布 `model` 分类时用于选择模型的会话选项 id |
| `discoveryTtlMs` | `600000` | 已发现目录保持权威的时长 |
| `discoveryTimeoutMs` | `30000` | 单次目录发现的时限，包含 agent 启动 |
| `maxSessions` | `4` | 保留的空闲 agent 会话数 |
| `sessionIdleMs` | `1800000` | 释放 agent 会话前的空闲时长 |
| `disposeEofGraceMs` | `6000` | stdin EOF 后等待 agent 冲刷并退出的宽限期 |
| `disposeGraceMs` | `3000` | 子进程 seam 使用的终止宽限期 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-devin-acp)是每个受支持字段及其 JSDoc 的完整来源。

### 模型发现

适配器启动 agent，打开一个临时会话，读取 agent 发布的 `model` 会话配置选项，随后删除该会话，并把结果缓存 `discoveryTtlMs`。因此列表反映账号自身的权限，并随 Devin 发布更新而更新，无需升级本包。刷新失败时继续提供上一次成功的目录，而不是清空此前仍可用的选择器。

### 你会得到什么

一次模型调用把对话作为单条文本提示转发，把 agent 的推理流为 reasoning 块、回答流为 text 块，并在 `end_turn` 时以 `stop` 结束，或在 agent 触及 token 上限时以 `max-tokens` 结束。被拒绝或被取消的回合以 `error` 或 `aborted` 结束。取消 harness 请求时会先通知 agent，待其有机会停止后才释放进程。

### 失败与恢复

启动、握手或会话失败会以一个携带失败阶段的 `DEVIN_ACP_FAILURE` 错误呈现，未认证账号以 `AUTH` 呈现并提示运维运行 `devin auth login`。agent 不提供的模型会在发送任何提示前以 `DEVIN_MODEL_UNAVAILABLE` 失败。这些失败不可重试：向可能已经修改过文件的 agent 重发提示比报告失败更糟，因此重试策略不会重试它们。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

### 每个 harness 会话一个 agent 会话

`stream()` 以循环为每个请求打上的 harness 会话 id 作为 agent 会话的键。会话的首次请求启动 `command args`，执行 ACP `initialize` 与 `session/new` 握手，并选择所需模型。后续请求复用该进程，只发送 agent 尚未见过的条目，因此 agent 保留它已建立的上下文。

### 对话投影

适配器转发用户文本、此前的助手文本与工具结果；丢弃 harness 系统提示、developer 更新与隐藏推理。全新的 agent 会话会收到带角色标签的完整对话记录，分叉、压缩重写或任何使对话不再延展已转发前缀的变化之后也同样如此。agent 自己上一条回答不会再回传给它。

### 生命周期

空闲会话在 `sessionIdleMs` 后释放，达到 `maxSessions` 上限时优先释放最近最少使用的空闲会话。卸载插件会释放所有会话。辅助请求——会话标题、压缩摘要以及其他带 purpose 的调用——运行在随后即被删除的一次性会话上，因此绝不会打断对话的上下文。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [LLM 流式子系统](../../../docs/subsystems/llm-streaming.zh.md) — 适配器契约、模型元数据与流协议。
- [dsh-subagent-acp](../../subagent/subagent-acp/README.zh.md) — 针对单个任务驱动同一协议的委派后端。
- [仅自动化 ACP 服务端](../../acp/acp/README.zh.md) — 同一协议的 harness 一侧。
- [dsh-subprocess seam](../../subprocess/subprocess/README.zh.md) — 每个 agent 进程所依赖的进程 seam。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-devin-acp) — 每个受支持配置字段及其来源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 助手请求

#### 模型看到什么

agent 以一次提示回合收到 `messages` 的投影条目，外加其自身进程的系统提示、规则与工具定义。它不会收到 harness 的 `request/header`、harness 工具 schema 或 harness 系统提示：这些描述的是本路由并不驱动的循环。

#### Token 影响

agent 为自己的上下文与多步历史付费。harness 请求不为任何工具 schema 付费，因为没有转发任何工具 schema；harness 会话只因 agent 的最终回答以及它流出的任何 `reasoning` 块而增长。

#### KV Cache 影响

与 harness 提供方缓存无关。agent 只在其自身的提供方、模型与历史相同的前缀上复用；当 harness 对话不再延展已转发前缀时，会启动全新的 agent 会话并支付完整重放的代价。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **工具循环由 agent 拥有** — 本路由从不调用 harness 工具，因此这些回合不会出现 harness 权限、工具卡片与工具结果事件。
- **仅文本提示** — 图片与文件以 harness 文本句柄的形式到达 agent；适配器从不转发附件字节，且该路由声明纯文本输入，使 harness 相应地投影附件。
- **单一工作目录** — 模型请求不携带工作区，因此每个 agent 进程都在 `cwd`（或 harness 进程目录）中运行。
- **Devin 保留自身历史** — 每个 harness 会话都会在 Devin CLI 自己的会话库中留下一个会话；适配器只删除自己的发现探测会话。
- **不做用量核算** — ACP 的 usage 更新携带的是上下文占用而非本回合计费 token，因此适配器不报告 token 用量，harness 只能估算。
- **推理强度由模型编码** — Devin 把思考等级并入模型 id（`swe-2-high`、`swe-2-max`），因此适配器不单独发布推理强度。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

- **会话复用依赖稳定的消息 id** — 已转发游标比较的是持久消息标识。任何就地重写消息的生产者都会迫使重放而不是增量。
- **用量可以变得精确** — 若 agent 未来在 ACP 上报告每回合计费，映射到 `TokenUsage` 会比估算更好。
- **图片转发** — 需要附件服务向适配器提供可读字节，并需要一项说明该能力的路由声明。

</details>
