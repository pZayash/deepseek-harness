# Agent Note: Delete a persisted Session

Status: implemented

English | [中文](2026-11-11-session-deletion.zh.md)

## Problem

No product surface can delete a persisted Session. `SessionPersistence` exposes create, open, flush, stat, and list; the JSONL backend removes only temporary files, and the Web, SDK, and ACP frontends all omit deletion. ACP therefore lists `session/delete` as unsupported, and an ACP or editor client can accumulate Sessions it cannot remove.

Deletion is destructive and spans several owners: the Session log (every retained format generation), the persisted projection cache, the `session-query` index, and the ACP protocol surface. It also races live Sessions, other processes, and in-flight readers.

## Decision

Add `SessionPersistence.remove(id, options)` as the storage contract. The base implementation throws a typed unsupported error, so backends gain deletion explicitly instead of silently inheriting a policy.

The JSONL backend deletes every retained generation of the Session directory atomically: acquire the Session lock, refuse when another process owns it, rename the directory under a trash prefix, then remove the renamed tree. A crash leaves only an ignored trash entry, never a half-deleted Session that `list` would resurrect. Missing Sessions report not-found; an unmaterialized pending Session has no artifact and reports not-found.

Ownership rules:

- A session active in this process (`ctx.sessions.get`) cannot be deleted.
- A write handle owned by this service refuses deletion; read handles do not block but observe not-found afterwards.
- A lock owned by another process fails loud, never forces deletion.
- Subagent Sessions are deleted with their owning root Session, child-first; a standalone subagent Session cannot be deleted.

Cross-package cleanup:

- The projection cache drops every row for the id after the log deletion commits.
- `session-query` may drop its indexed rows on the `session/deleted` event; until it subscribes, a rescan repairs the derived index, so storage deletion stays correct without it.
- Attachments stay: they are content-addressed and may be shared by other Sessions or still-open reads. A separate retention job owns orphaned attachment objects.
- Titles, stats, and checkpoints live in the projection cache and disappear with it.

`session/deleted` is a host service event emitted by the persistence provider after the artifact disappears, never a Session log event: the log is the thing being removed. ACP advertises `sessionCapabilities.delete: {}` and implements `session/delete`: refuse an active member, validate a non-subagent root, delete every persisted descendant child-first, and return `{}`.

## Alternatives considered

**Delete files from the ACP bridge.** Rejected: frontends must not own storage layout, locks, or format generations; the Web and SDK need the same capability.

**Soft delete a flag on the header.** Rejected: every reader (list, resume, query index, title cache) would have to filter the flag, and the artifacts would still grow.

**Delete only the current format generation.** Rejected: a retained predecessor generation would reappear as the Session after restart.

**Delete attachment objects with the Session.** Rejected: attachments are content-addressed and may be shared; ownership is not per Session.

**Route deletion exclusively through `session-query`.** Rejected: the query index is derived and optional; storage must remain correct without it.

## Consequences

Deletion is irreversible; the trash rename is the only recovery window, and a crash leaves an ignored `.trash` entry rather than a resurrectable Session. A cross-process lock race can delete a Session another process just started reading, so readers treat not-found as a valid outcome. The projection cache loses titles, stats, and checkpoints for the deleted tree, and `session-query` serves stale rows until it subscribes to `session/deleted` or rescans. Attachments survive as shared content-addressed objects. ACP deletes a root with its descendants child-first and refuses while any member is active.

Verification: the persistence removal contract covers successful removal from stat/list/open, not-found for absent and unmaterialized Sessions, and refusal of an active write handle; the JSONL suite covers the emitted `session/deleted` event; ACP tests cover successful deletion, the active refusal, and descendant removal. A keyless recorded snapshot remains deferred with the other ACP scenarios on the Windows checkout.

