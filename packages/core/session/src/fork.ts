/**
 * Fork seed construction over an exact source-event prefix.
 * @module @deepseek-ai/dsh-session/fork
 */

import { openTurnClosers } from './repair.ts'
import { SessionSeq } from './types.ts'
import type { SessionEvent, SessionSeq as SessionSeqType } from './types.ts'

/**
 * Resolve the omitted fork boundary to the latest completed-turn prefix,
 * including standalone events committed before the next turn begins.
 * @param events - source log with contiguous seqs from zero.
 * @returns the inclusive seq of the last event in the latest completed-turn
 *   prefix, or `undefined` when the log has no `turn/end`.
 */
export function latestCompletedPrefixBoundary(events: readonly SessionEvent[]): SessionSeqType | undefined {
  const lastTurnEnd = events.findLast(event => event.type === 'turn/end')
  if (lastTurnEnd === undefined) return undefined
  let boundary = lastTurnEnd.seq
  for (const next of events.slice(boundary + 1)) {
    // `agent/inbox/spliced` is declared by the agent package's merge-extensible
    // SessionEventMap; core/session must not import that package, so the
    // discriminant is widened for this extension event only.
    const type: string = next.type
    if (type === 'turn/start' || (next.type === 'user/message' && next.surfaceOp === 'append')
      || type === 'agent/inbox/spliced') break
    boundary = next.seq
  }
  return boundary
}

/**
 * Copy an inclusive event prefix, mark its inherited cut, and close its open tail with forked results
 * and step/turn endings. Closed steps and turns are preserved unchanged.
 * The caller validates that the boundary is an existing contiguous event seq;
 * Session construction snapshots the borrowed events before publication.
 *
 * @param events - source log with contiguous seqs from zero.
 * @param boundary - inclusive source event seq the child inherits through.
 * @returns a new array retaining the source event objects, followed by synthetic
 *   closers outside the inherited prefix counted by `inheritedEventCount`.
 */
export function buildForkSeed(events: readonly SessionEvent[], boundary: SessionSeqType): SessionEvent[] {
  const prefix = events.slice(0, boundary + 1)
  prefix.push({
    type: 'session/end-seed', seq: SessionSeq(boundary + 1),
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the caller validated this exact source event.
    time: events[boundary]!.time,
    data: { inherited: true },
  })
  return prefix.concat(openTurnClosers(prefix, { kind: 'forked' }))
}
