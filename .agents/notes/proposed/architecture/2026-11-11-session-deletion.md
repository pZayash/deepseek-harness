# Agent Note: Delete a persisted Session

Status: proposed

English | [中文](2026-11-11-session-deletion.zh.md)

## Problem

No product surface can delete a persisted Session. `SessionPersistence` exposes create, open, flush, stat, and list; the JSONL backend removes only temporary files, and the Web, SDK, and ACP frontends all omit deletion. ACP therefore lists `session/delete` as unsupported, and an ACP or editor client can accumulate Sessions it cannot remove.

Deletion is destructive and spans several owners: the Session log (every retained format generation), the persisted projection cache, the `session-query` index, and the ACP protocol surface. It also races live Sessions, other processes, and in-flight readers.

## Proposal

Add `SessionPersistence.remove(id, options)` as the storage contract. The base implementation throws a typed unsupported error, so backends gain deletion explicitly instead of silently inheriting a policy.

The JSONL backend deletes every retained generation of the Session directory atomically: acquire the Session lock, refuse when another process owns it, rename the directory under a trash prefix, then remove the renamed tree. A crash leaves only an ignored trash entry, never a half-deleted Session that `list` would resurrect. Missing Sessions report not-found; an unmaterialized pending Session has no artifact and reports not-found.

Ownership rules:

- A session active in this process (`ctx.sessions.get`) cannot be deleted.
- A write handle owned by this service refuses deletion; read handles do not block but observe not-found afterwards.
- A lock owned by another process fails loud, never forces deletion.
- Subagent Sessions are deleted with their owning root Session or refused, not deleted standalone.

Cross-package cleanup:

- The projection cache drops every row for the id after the log deletion commits.
- `session-query` drops its indexed rows on a new `session/deleted` event; a backend that misses the event drops them on the next rescan, so deletion stays correct without an index.
- Attachments stay: they are content-addressed and may be shared by other Sessions or still-open reads. A separate retention job owns orphaned attachment objects.
- Titles, stats, and checkpoints live in the projection cache and disappear with it.

ACP advertises `sessionCapabilities.delete: {}` and implements `session/delete`: validate an inactive non-subagent root Session with the request workspace, call `remove`, and return `{}`. The client learns the Session is gone from the response and the next `session/list`.

## Alternatives considered

**Delete files from the ACP bridge.** Rejected: frontends must not own storage layout, locks, or format generations; the Web and SDK need the same capability.

**Soft delete a flag on the header.** Rejected: every reader (list, resume, query index, title cache) would have to filter the flag, and the artifacts would still grow.

**Delete only the current format generation.** Rejected: a retained predecessor generation would reappear as the Session after restart.

**Delete attachment objects with the Session.** Rejected: attachments are content-addressed and may be shared; ownership is not per Session.

**Route deletion exclusively through `session-query`.** Rejected: the query index is derived and optional; storage must remain correct without it.

## Open questions

- Should `session/deleted` be a durable Session event on the root log (wrong: the log is being removed) or a host service event emitted by the persistence provider? The latter keeps storage and indexing decoupled.
- Should the Web surface deletion in the same change, or only ACP first?
- How long should the trash tree be retained before the startup cleanup removes it?
- Should deleting a root Session also delete its subagent children, or refuse while continuable children exist?

## Acceptance criteria

JSONL contract tests cover deletion of every generation, not-found, another-process ownership, an open write handle, and trash recovery. Projection-cache and session-query tests cover row removal. ACP tests cover capability advertisement, successful deletion, inactive requirement, workspace mismatch, and subagent refusal. A keyless recorded snapshot covers the ACP request and response.

## Risks

- Deletion is irreversible: a wrong id or an eager trash cleanup destroys history. The trash rename is the only recovery window.
- A cross-process lock race can delete a Session another process just started reading; readers must treat not-found as a valid outcome.
- An index backend that misses `session/deleted` serves stale rows until its next rescan.
- Deleting a root Session with live subagent children can strand their continuations; child-first disposal must precede artifact removal.

