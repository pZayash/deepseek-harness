/** Standard ACP updates derived from committed DSH session events. */

import type { Context } from '@deepseek-ai/cordis'
import { isAbsolute, resolve } from 'node:path'
import type { SessionUpdate, ToolCall, ToolCallContent, ToolCallLocation } from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { errorChain, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-token-meter'
// Side-effect type import: declaration-merges the optional `ctx.tools` service
// read below. `ToolCallView` is the consumed tool-owned render intent.
import type { FileLocation, ToolCallView } from '@deepseek-ai/dsh-tools'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { assistantBlockToAcp } from './content.ts'

/**
 * Convert one committed assistant message and its context usage in block order.
 * @param ctx - bridge context carrying attachment and token-meter services.
 * @param session - durable session used for context pressure.
 * @param event - committed assistant message event.
 * @returns ordered standard thought, message, and optional usage updates.
 */
export async function assistantUpdates(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
): Promise<SessionUpdate[]> {
  const updates: SessionUpdate[] = []
  for (const block of event.data.message.content) {
    if (block.type === 'reasoning') {
      if (block.text.length > 0) {
        updates.push({
          sessionUpdate: 'agent_thought_chunk',
          messageId: event.data.message.id,
          content: { type: 'text', text: block.text },
        })
      }
      continue
    }
    const content = await assistantBlockToAcp(ctx, block)
    if (content !== undefined) {
      updates.push({
        sessionUpdate: 'agent_message_chunk',
        messageId: event.data.message.id,
        content,
      })
    }
  }
  const usage = usageUpdate(ctx, session, event)
  if (usage !== undefined) updates.push(usage)
  return updates
}

/**
 * Project one committed call fact into the standard ACP tool-call fields.
 * The owning tool's pure `presentCall` render intent supplies the standard
 * title, kind, locations, salient input, and authored text content; an absent
 * registry, definition, or intent, malformed argument JSON, or a throwing
 * presenter falls back to the generic card. The result doubles as the
 * `tool_call` update body and the permission-request tool call, so it is
 * computed synchronously when the event commits.
 * @param ctx - bridge context carrying the optional tool registry.
 * @param agent - call-owning Agent; also its tool-registry viewing scope.
 * @param event - committed DSH tool-call event.
 * @returns the standard in-progress tool-call fields.
 */
export function toolCallUpdate(
  ctx: Context,
  agent: Agent,
  event: SessionEvent<'tool/call'>,
): ToolCall {
  const parsed = tryParseToolArguments(event.data.arguments)
  const rawInput = parsed.ok ? parsed.args : event.data.arguments
  const view = parsed.ok ? callView(ctx, agent, event.data.name, parsed.args) : undefined
  const base = {
    toolCallId: event.data.callId,
    status: 'in_progress' as const,
    rawInput,
  }
  if (view === undefined) return { ...base, title: event.data.name, kind: 'other' }
  const cwd = agent.session.header.cwd
  switch (view.card) {
    case 'generic':
      return {
        ...base,
        title: view.title,
        kind: view.kind ?? 'other',
        ...view.rawInput !== undefined ? { rawInput: view.rawInput } : {},
        ...view.locations === undefined ? {} : { locations: acpLocations(view.locations, cwd) },
        ...view.content === undefined ? {} : { content: acpCallContent(view.content) },
      }
    case 'terminal':
      return {
        ...base,
        title: view.title,
        kind: 'execute',
        ...view.description === undefined ? {} : { content: [{ type: 'content', content: { type: 'text', text: view.description } }] },
      }
    case 'diff':
      return {
        ...base,
        title: view.title,
        kind: 'edit',
        ...view.locations === undefined ? {} : { locations: acpLocations(view.locations, cwd) },
        content: view.diffs.map(diff => ({
          type: 'diff',
          path: absolutePath(diff.path, cwd),
          oldText: diff.oldText,
          newText: diff.newText,
        })),
      }
    /* v8 ignore next -- the closed ToolCallView union is covered above. */
    default: return assertNever(view)
  }
}

/**
 * Finish one generic ACP tool lifecycle from its committed model-facing result.
 * @param ctx - bridge context carrying the attachment store.
 * @param event - committed DSH tool-result event.
 * @returns the standard completed or failed tool-call update.
 */
export async function toolResultUpdate(
  ctx: Context,
  event: SessionEvent<'tool/result'>,
): Promise<SessionUpdate> {
  const message = event.data.message
  const content: ToolCallContent[] = []
  for (const block of message.content) {
    const converted = await assistantBlockToAcp(ctx, block)
    if (converted !== undefined) content.push({ type: 'content' as const, content: converted })
  }
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: message.toolCallId,
    status: message.isError === true ? 'failed' : 'completed',
    content,
  }
}

/** Report current context occupancy only when DSH has both usage and capacity facts. */
function usageUpdate(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
): SessionUpdate | undefined {
  if (event.data.usage === undefined) return undefined
  const size = session.requestContext()?.contextWindow
  const meter = ctx.get('tokenMeter')
  if (size === undefined || meter === undefined) return undefined
  return {
    sessionUpdate: 'usage_update',
    used: meter.measure(session).totalTokens,
    size,
  }
}

/** Resolve the tool-owned render intent; a throwing presenter degrades to the generic card. */
function callView(ctx: Context, agent: Agent, name: string, args: unknown): ToolCallView | undefined {
  try {
    return ctx.get('tools')?.get(name, agent)?.presentCall?.(args)
  } catch (error: unknown) {
    ctx.logger.warn(`acp: tool "${name}" presentCall threw, using generic presentation: ${errorChain(error)}`)
    return undefined
  }
}

/** Anchor a model-facing path to the session workspace; ACP file paths are absolute. */
function absolutePath(path: string, cwd: string | undefined): string {
  return cwd !== undefined && !isAbsolute(path) ? resolve(cwd, path) : path
}

/** Map tool-declared follow-along files onto absolute ACP locations. */
function acpLocations(locations: readonly FileLocation[], cwd: string | undefined): ToolCallLocation[] {
  return locations.map(location => ({
    path: absolutePath(location.path, cwd),
    ...location.line === undefined ? {} : { line: location.line },
  }))
}

/**
 * Map tool-authored call-card text onto standard content entries. Other
 * committed block kinds have no synchronous wire form: the call projection
 * also feeds the permission request, which is filled when the event commits.
 */
function acpCallContent(blocks: readonly ContentBlock[]): ToolCallContent[] {
  const content: ToolCallContent[] = []
  for (const block of blocks) {
    if (block.type === 'text' && block.text.length > 0) {
      content.push({ type: 'content', content: { type: 'text', text: block.text } })
    }
  }
  return content
}

/**
 * Parse committed tool-call arguments. `ok: false` preserves malformed model
 * output as opaque input instead of dropping the call update.
 */
function tryParseToolArguments(value: string): { ok: true; args: unknown } | { ok: false } {
  try {
    return { ok: true, args: JSON.parse(value) as unknown }
  } catch (_invalidModelJson) {
    return { ok: false }
  }
}
