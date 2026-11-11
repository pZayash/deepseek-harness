---
description: "The Devin ACP model provider for users who want Devin models in the harness model picker, and for maintainers wiring an ACP agent as an LLM route."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-devin-acp

English | [中文](README.zh.md)

## Summary

Use this package to run a harness session on the models the Devin CLI offers. It registers one LLM provider whose catalog is read live from the Devin ACP agent, so a model picker shows only models the signed-in account may select. Each harness session gets its own long-lived Devin process: the provider forwards conversation text, lets the agent plan, edit, and run commands with its own tools, and records its final answer as the step's assistant message. Choose it when Devin should do the work; choose a harness provider when the harness must execute the tools.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this provider on any composition that already has the `llm` service and the subprocess seam. `devin acp` is a full ACP agent server, so the only required configuration is the executable.

```yaml
- id: llm-devin
  name: '@deepseek-ai/dsh-llm-devin-acp'
  config:
    providerName: devin
    command: C:\Users\me\AppData\Local\devin\cli\bin\devin.exe
    permission: allow
```

The provider route appears in the model picker as `devin` with its live model list, and a session can select any advertised model.

### When to choose it

Choose this provider when the Devin agent should do the work: it keeps its own context, edits files, and runs commands in the configured directory, and the harness session records its answers. Choose a harness provider when the model must call harness tools, honor harness permissions, or stream harness tool activity into the session; this provider never emits tool calls, because the agent executes its own.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `devin` | Provider route offered to model selectors |
| `displayName` | `Devin` | Human-readable provider name |
| `command` | required | The Devin executable |
| `args` | `['acp']` | Arguments passed to `command` |
| `env` | `{}` | Explicit agent environment layered over the credential-scrubbed parent environment |
| `cwd` | harness process directory | Working directory for every agent process and session |
| `permission` | `reject` | Auto-answer the agent's permission prompts by rejecting, or choosing the first `allow_once` or `allow_always` option (`allow`) |
| `modelConfigId` | `model` | Session option id that selects the model when the agent publishes no `model` category |
| `discoveryTtlMs` | `600000` | How long a discovered catalog stays authoritative |
| `discoveryTimeoutMs` | `30000` | Bound for one catalog discovery, including agent startup |
| `maxSessions` | `4` | Idle agent sessions kept alive |
| `sessionIdleMs` | `1800000` | Idle time after which an agent session is released |
| `disposeEofGraceMs` | `6000` | Grace after stdin EOF for the agent to flush and exit |
| `disposeGraceMs` | `3000` | Termination grace used by the subprocess seam |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-devin-acp) is the exhaustive source for every accepted field and its JSDoc.

### Model discovery

The adapter starts the agent, opens one temporary session, reads the `model` session configuration option the agent publishes, deletes that session again, and caches the result for `discoveryTtlMs`. The list therefore reflects the account's own entitlements and follows Devin releases without a package update. A refresh that fails keeps serving the last successful catalog instead of emptying a selector that was working a moment ago.

### What you get

A model call forwards the conversation as one text prompt, streams the agent's reasoning as reasoning blocks and its answer as a text block, and finishes with `stop` on `end_turn` or `max-tokens` on the agent's token limit. A refused or cancelled turn finishes as `error` or `aborted`. Cancelling the harness request notifies the agent first and releases the process only after the agent had a moment to stop.

### Failure and recovery

A spawn, handshake, or session failure surfaces as one `DEVIN_ACP_FAILURE` error carrying the failing stage, and an unauthenticated account surfaces as `AUTH` telling the operator to run `devin auth login`. A model the agent does not offer fails as `DEVIN_MODEL_UNAVAILABLE` before any prompt is sent. These failures are not retryable: resending a prompt to an agent that may already have edited files is worse than reporting the failure, so the retry policy leaves them alone.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### One agent session per harness session

`stream()` keys its agent sessions by the harness session id the loop stamps on every request. The first request of a session spawns `command args`, performs the ACP `initialize` and `session/new` handshake, and selects the requested model. Later requests reuse that process and send only the entries the agent has not seen, so the agent keeps the context it built.

### Transcript projection

The adapter forwards user text, earlier assistant text, and tool results; it drops the harness system prompt, developer updates, and hidden reasoning. A fresh agent session receives the whole conversation as a labelled transcript, which is also what happens after a fork, a compaction rewrite, or any other change that stops the conversation from extending the forwarded prefix. The agent's own previous answer is never echoed back to it.

### Lifecycle

Idle sessions are released after `sessionIdleMs`, and the least recently used idle session is released first when `maxSessions` is reached. Unloading the plugin releases every session. Auxiliary requests — session titles, compaction summaries, and other purpose-tagged calls — run on a throwaway session that is deleted afterwards, so they never interrupt the conversation's context.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — the adapter contract, model metadata, and stream protocol.
- [dsh-subagent-acp](../../subagent/subagent-acp/README.md) — the delegation backend that drives the same protocol for one task.
- [Automation-only ACP server](../../acp/acp/README.md) — the harness side of the same protocol.
- [dsh-subprocess seam](../../subprocess/subprocess/README.md) — the process seam every agent process rides.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-devin-acp) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Assistant request

#### What the model sees

The agent receives the projected entries of `messages` as one prompt turn, plus its own process's system prompt, rules, and tool definitions. It does not receive the harness `request/header`, the harness tool schemas, or the harness system prompt: those describe a loop this route does not drive.

#### Token effect

The agent pays for its own context and multi-step history. The harness request pays nothing per tool schema, because none are forwarded, and the harness Session grows only by the agent's final answer plus any `reasoning` blocks the agent streamed.

#### KV Cache effect

Independent of harness provider caching. The agent reuses prefixes only under its own provider, model, and history; a harness conversation that no longer extends the forwarded prefix starts a fresh agent session and pays a full replay.

## Known Limitations and Deferred Work

- **The agent owns the tool loop** — harness tools are never called through this route, so harness permissions, tool cards, and tool-result events do not appear for these turns.
- **Text prompts only** — images and files reach the agent as harness text handles; the adapter never forwards attachment bytes, and the route declares text-only input so the harness projects attachments accordingly.
- **One working directory** — a model request carries no workspace, so every agent process runs in `cwd` (or the harness process directory).
- **Devin keeps its history** — each harness session leaves one session in the Devin CLI's own session store; the adapter deletes only its discovery probes.
- **No usage accounting** — the ACP usage update carries context occupancy rather than this turn's billed tokens, so the adapter reports no token usage and the harness must estimate.
- **Reasoning effort is model-encoded** — Devin publishes its thinking level as part of the model id (`swe-2-high`, `swe-2-max`), so the adapter advertises no separate reasoning efforts.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

- **Session reuse relies on stable message ids** — the forwarded cursor compares durable message identities. Any producer that rewrites messages in place would force a replay rather than a delta.
- **Usage could become exact** — if the agent ever reports per-turn billing on ACP, mapping it into `TokenUsage` would be preferable to estimation.
- **Image forwarding** — would need the attachment service to hand the adapter readable bytes, and a route capability that says so.

</details>
