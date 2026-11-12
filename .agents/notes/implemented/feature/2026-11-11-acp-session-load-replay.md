# Agent Note: ACP session/load replays committed history

Status: implemented

English | [中文](2026-11-11-acp-session-load-replay.zh.md)

## Problem

The bridge advertised list, resume, close, and fork but omitted standard `session/load`. A client could reopen a persisted session with `session/resume` only as an empty transcript: resume restores the Agent and configuration but deliberately sends no history. Editor clients therefore lost the conversation on reopen, and the automation boundary listed `session/load` as unsupported.

## Decision

`initialize` advertises `loadSession: true`. `session/load` validates a persisted inactive root session (non-subagent, canonical workspace match, no active owner), reads its complete log through persistence, composes the Agent through the same resume path, replays the visible conversation as standard `session/update` notifications, drains the per-session update chain, and only then returns the complete configuration options.

Replay walks `Session.surface.nodes`, so a compacted or replaced range contributes only its replacement. Human-authored user and assistant text and images become `user_message_chunk`/`agent_message_chunk`; model-facing user-role context (runtime snapshots, developer instructions, compaction summaries) and assistant reasoning are skipped. Tool lifecycle reuses the same `toolCallUpdate`/`toolResultUpdate` projections as live delivery, retaining each call's committed name and arguments to complete the result card. The latest committed `todo/write` becomes one replacement `plan`. Usage is omitted because it is live-turn telemetry. An unavailable historical image is skipped with a warning instead of failing the load.

Reading the complete log is an explicit storage read, matching the [complete-history rule](../architecture/2026-09-09-deprecate-synchronous-session-event-reads.md); replay is outbound-only and appends no events.

## Alternatives considered

**Replay raw committed events.** Rejected: after compaction or a surface replacement the shadowed originals would reappear in the client.

**Replay `deriveMessages()`.** Rejected: derived messages lose tool-call identity and the tool-owned render intents that produce standard cards; reconstructing calls from assistant content would duplicate the projection.

**Include reasoning and usage in replay.** Rejected: both describe the live turn, not conversation history, and would flood clients on large sessions.

**Expose history paging.** Rejected: ACP has no paging method; `session/load` is the standard history surface, and the replay is bounded by the visible conversation.

**Allow loading an active session.** Rejected: a second writer or observer would race the live update chain and duplicate delivery.

## Consequences

Clients reopen a session with its conversation, tool cards, and current plan. Load cost scales with visible history and one full log read. Tool cards use the current registry: a tool removed since recording falls back to the generic card. Historical images require the durable attachment store and degrade to omission. Reasoning and context usage do not reappear in the reopened client.

## Related decisions

[ACP as an automation-only protocol](../simplification/2026-07-23-acp-automation-only-protocol.md) owns the automation boundary; [standard ACP vocabulary from committed render intents](2026-11-04-acp-standard-presentation-vocabulary.md) owns the card projection this replay reuses; [multiplex concurrent ACP sessions](../../archived/feature/2026-06-14-acp-multi-session.md) owns per-session isolation.
