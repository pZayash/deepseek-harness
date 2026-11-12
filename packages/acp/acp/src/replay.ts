/** Standard ACP history replay derived from one committed DSH session log. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-todo'
import { assistantBlockToAcp } from './content.ts'
import { planUpdate, toolCallUpdate, toolResultUpdate } from './updates.ts'

/**
 * Project the model-visible history of one committed log onto standard ACP
 * updates. The session surface selects visible events, so a compacted or
 * replaced range replays as its replacement; tool results pull their matching
 * call fact, and the latest committed todo list lands last as the current plan.
 * Reasoning and usage stay off the replay: they are live-turn telemetry, not
 * conversation history. An unavailable historical image is skipped with a
 * warning instead of failing the whole load.
 *
 * @param ctx - bridge context carrying the optional tool registry and attachments.
 * @param agent - resumed Agent owning the surface and tool-registry scope.
 * @param events - complete persisted session log in seq order.
 * @returns ordered standard updates for one replay.
 */
export async function replayUpdates(
  ctx: Context,
  agent: Agent,
  events: readonly SessionEvent[],
): Promise<SessionUpdate[]> {
  const updates: SessionUpdate[] = []
  const bySeq = new Map(events.map(event => [event.seq, event]))
  const calls = new Map<string, SessionEvent<'tool/call'>>()
  for (const event of events) {
    if (event.type === 'tool/call') calls.set(event.data.callId, event)
  }

  for (const seq of agent.session.surface.nodes) {
    const event = bySeq.get(seq)
    if (event === undefined) continue
    switch (event.type) {
      case 'user/message':
        // Model-facing context snapshots (runtime context, developer
        // instructions, compaction summaries) commit as user-role messages too;
        // they are not conversation turns and stay out of the client transcript.
        if (event.data.source.kind !== 'user') break
        for (const block of event.data.content) {
          const content = await replayBlock(ctx, block)
          if (content !== undefined) {
            updates.push({ sessionUpdate: 'user_message_chunk', messageId: event.data.id, content })
          }
        }
        break
      case 'assistant/message':
        for (const block of event.data.message.content) {
          if (block.type === 'reasoning') continue
          const content = await replayBlock(ctx, block)
          if (content !== undefined) {
            updates.push({ sessionUpdate: 'agent_message_chunk', messageId: event.data.message.id, content })
          }
        }
        break
      case 'tool/result': {
        const call = calls.get(event.data.message.toolCallId)
        if (call !== undefined) {
          updates.push({ sessionUpdate: 'tool_call', ...toolCallUpdate(ctx, agent, call) })
        }
        updates.push(await toolResultUpdate(
          ctx,
          agent,
          event,
          call === undefined ? undefined : { name: call.data.name, arguments: call.data.arguments },
        ))
        break
      }
      default:
        break
    }
  }

  const plan = events.findLast((event): event is SessionEvent<'todo/write'> => event.type === 'todo/write')
  if (plan !== undefined) updates.push(planUpdate(plan))
  return updates
}

/** Convert one historical block, degrading an unavailable attachment to omission. */
async function replayBlock(
  ctx: Context,
  block: Parameters<typeof assistantBlockToAcp>[1],
): Promise<Awaited<ReturnType<typeof assistantBlockToAcp>>> {
  try {
    return await assistantBlockToAcp(ctx, block)
  } catch (error: unknown) {
    ctx.logger.warn(`acp: replay skipped unavailable content: ${errorChain(error)}`)
    return undefined
  }
}
