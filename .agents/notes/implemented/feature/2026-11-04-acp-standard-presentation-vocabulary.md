# Agent Note: Standard ACP vocabulary from committed render intents

Status: implemented

English | [中文](2026-11-04-acp-standard-presentation-vocabulary.zh.md)

## Problem

The [ACP automation-only boundary](../simplification/2026-07-23-acp-automation-only-protocol.md) was drawn at committed semantic facts and excluded presentation literally: every tool call reached the wire as the tool name for a title, `kind: 'other'`, and no locations, diffs, or authored content, while `session/request_permission` carried a bare call id and `initialize` hardcoded version `0.0.1`. Graphical ACP clients could render only generic rows and uninformative permission prompts. Because the exclusion was literal — it rejected even a correctly built render-intent bridge — restoring any of it requires an explicit decision about which presentation belongs on an automation transport.

## Decision

The redrawn boundary: standard ACP vocabulary derived from committed session facts plus pure tool-owned render intents is in; DSH-private presentation, client-capability features, and uncommitted data stay out. The earlier note keeps the automation-only decision; this note supersedes its exclusion list for standard fields.

`toolCallUpdate(ctx, agent, event)` resolves `ctx.get('tools')?.get(name, agent)?.presentCall(args)`, the same pure render-intent seam that Host presenters and Web cards consume, and maps the tagged `ToolCallView` onto standard `ToolCall` fields: the view's title for every card; `kind` from the generic card's declared value, `execute` for a terminal card, `edit` for a diff card; `locations` with model-facing paths resolved against `session.header.cwd`, since ACP file paths are documented absolute; the generic card's salient `rawInput` or the committed arguments; the card's authored text as `content` entries; and a diff card's `FileDiff`s as `{type:'diff'}` content entries with the same absolutization. Malformed argument JSON, an absent registry, definition, or intent, and a throwing presenter all fall back to the generic card: the tool name as title, `kind: 'other'`, and the parsed-or-raw arguments. Call-card content maps text blocks only, because the projection must complete synchronously.

The emitted card is stored synchronously in a per-session map when `tool/call` commits, paired with the call's committed name and raw arguments, deleted per call on `tool/result`, and cleared wholesale on `turn/end` for calls aborted without a result. `tool/call` commits before `pipeline.prepare` and `approval/request`, and `session/event` observers run synchronously, so `session/request_permission` always embeds the exact emitted ToolCall; an unresolved call id keeps the `{toolCallId}`-only fallback. One-shot `allow-once` remains the first option, because the client's choice order is a wire contract.

`toolResultUpdate(ctx, agent, event, call)` applies the same seam to the completed state: the retained committed name and raw arguments — a `tool/result` event carries neither — resolve `ctx.get('tools')?.get(name, agent)?.presentResult(args, {content, isError, meta})`, where `meta` is the event's persisted presentation payload. A `diff` intent appends `{type:'diff'}` entries beside the converted content blocks; persisted diff paths are already absolute, so the result-time projection needs no cwd resolution. Every intent's `title` replaces the card title; other card kinds keep the raw-content projection. A missing retained call, registry, definition, or intent, malformed call JSON, and a throwing presenter all keep the raw-content projection.

`todo/write` commits a whole-list snapshot, so its projection is the standard `plan` update: a complete replacement `entries` list mapped entry-for-entry from the committed `TodoItem`s — `content` and the shared three-state `status` pass through, while `priority`, a required protocol field with no committed source, stays fixed at `'medium'`. A `turn/start` emits the clearing `plan` only after a plan was emitted this session, matching the `todos` projection's own turn-boundary fold; a composition that never writes a todo list emits no plan at all.

`initialize` reports `agentInfo.version` read from `../package.json` relative to `import.meta.url` through `fileURLToPath` — the executable's virtual filesystem intercepts string paths, not URL arguments — validated as a semantic version; an unreadable or invalid version fails plugin load. `../package.json` resolves the package root from both `src/` and `lib/`.

`@deepseek-ai/dsh-tools` is an optional peer dependency: a composition without the registry keeps the generic card, matching the `permissionPresets`/`tokenMeter` optional-service pattern.

Every field derives from the committed `tool/call` and `tool/result` facts and pure functions of them, so model-visible⟺logged holds and the change needs no session event, format version, or projection.

## Alternatives considered

**Keep the literal exclusion of all presentation fields.** Rejected because it conflated standard protocol vocabulary with UI features: `ToolKind`, `locations`, `diff` content, and a full permission `toolCall` are ACP's own vocabulary, and the render intents are pure tool-owned projections rather than bridge-owned presentation policy. The exclusion's stated objection — coupling an automation transport to editor conventions — does not apply to fields the protocol itself defines.

**A hardcoded tool-name→kind table.** Rejected because the render-intent seam already owns per-tool presentation and the same table would drift from the tools.

**Client-capability features.** Still rejected on the unchanged boundary: ACP `terminal` content and `terminal/*` methods delegate execution to the client, so shell output stays text; pre-commit streaming stays out because ACP has no chunk revoke.

**Gate the fields behind a config opt-in.** Rejected because the added fields are standard vocabulary and strictly additive for automation consumers; `dsh-subagent-acp` reads only `toolCall.kind` beyond the fields it already used.

## Consequences

Graphical clients render meaningful tool cards and permission prompts with file follow-along and call- and result-time diffs; automation consumers receive strictly additive fields. The bridge becomes an optional consumer of the tool render-intent seam, and each session keeps a bounded map of in-flight call projections and identities. Call-time diffs derive from call arguments, so a create's `oldText` is `null`; result-time diffs derive from the persisted applied-change metadata. Richer result content and terminal cards remain off the wire.
