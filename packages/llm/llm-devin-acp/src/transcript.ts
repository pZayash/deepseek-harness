/**
 * Prompt projection for the Devin ACP provider.
 *
 * ACP agents take a prompt turn, not a chat-completion request. This module
 * turns the assembled harness messages into stable entries, so one long-lived
 * Devin session receives each user message exactly once, and renders the
 * entries into the text a fresh session needs to continue a conversation.
 *
 * @module @deepseek-ai/dsh-llm-devin-acp/transcript
 */

import { createHash } from 'node:crypto'
import type { ContentBlock, RequestMessage } from '@deepseek-ai/dsh-llm'

/** Roles a forwarded entry can carry into the agent prompt. */
export type TranscriptRole = 'user' | 'assistant' | 'tool' | 'system'

/** One conversation entry forwarded to the agent, with the identity that decides whether it was already sent. */
export interface TranscriptEntry {
  /**
   * Stable identity of the source message: its durable id, or a content digest
   * for an identity-free request input. Two entries share a key only when they
   * forward the same message, so a matching prefix means the agent has already
   * seen it.
   */
  readonly key: string
  /** Role label rendered ahead of the text when the entry joins a multi-entry prompt. */
  readonly role: TranscriptRole
  /** Model-visible text, empty when the message carried nothing this provider forwards. */
  readonly text: string
}

/** Text one content block contributes; blocks the agent cannot act on contribute nothing. */
function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text': return block.text
    // A model's hidden reasoning is never replayed into another model's prompt.
    case 'reasoning': return ''
    // Attachment bytes are not forwarded (see the package README); the label
    // still tells the agent that the user attached something.
    case 'image': return block.offloaded === true
      ? `[image offloaded: ${block.attachment.name ?? block.attachment.mediaType}]`
      : `[image: ${block.attachment.name ?? block.attachment.mediaType}]`
    case 'file': return `[file: ${block.attachment.name}]`
    // Foreign tool traffic belongs to the harness loop this provider does not drive.
    case 'tool-call':
    case 'tool-addition':
    case 'tool-removal':
      return ''
    default: return ''
  }
}

/** Join the forwarded text of one message's blocks, preserving paragraph breaks between text blocks. */
function messageText(content: readonly ContentBlock[]): string {
  return content.map(blockText).filter(text => text.length > 0).join('\n\n').trim()
}

/** Digest that gives identity-free request input a stable forwarding key. */
function contentKey(role: TranscriptRole, text: string): string {
  return createHash('sha256').update(`${role}\u0000${text}`).digest('hex').slice(0, 32)
}

/**
 * Project assembled request messages into forwarded entries.
 *
 * Tool traffic, developer updates, and (unless requested) the system prompt are
 * dropped: the agent runs its own loop with its own instructions. Empty
 * entries are dropped too, so the cursor never advances past a message the
 * agent did not actually receive.
 * @param messages - the request messages, in conversation order.
 * @param includeSystem - whether the leading system prompt belongs in the prompt
 *   (auxiliary one-shot calls carry their instruction there; a conversation
 *   prompt belongs to the agent's own system prompt instead).
 * @returns forwarded entries in conversation order.
 */
export function transcriptEntries(messages: readonly RequestMessage[], includeSystem: boolean): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const message of messages) {
    if (message.role === 'developer') continue
    if (message.role === 'system' && !includeSystem) continue
    const raw = messageText(message.content)
    const text = message.role === 'tool' && message.isError === true ? `(error) ${raw}` : raw
    if (text.length === 0) continue
    const role: TranscriptRole = message.role
    // A tool message has no durable id of its own beyond the message id, which
    // is as stable as any other message's.
    entries.push({ key: message.id ?? contentKey(role, text), role, text })
  }
  return entries
}

/**
 * Select entries the agent has not received yet.
 * @param entries - the current conversation projection.
 * @param cursor - keys forwarded to this agent session so far, in order.
 * @returns the entries after the recorded prefix, or `undefined` when the
 *   conversation no longer extends that prefix (a fork, a compaction rewrite,
 *   or a different session), which requires a fresh agent session.
 */
export function tailAfter(
  entries: readonly TranscriptEntry[],
  cursor: readonly string[],
): readonly TranscriptEntry[] | undefined {
  if (cursor.length > entries.length) return undefined
  for (let index = 0; index < cursor.length; index += 1) {
    if (entries[index]?.key !== cursor[index]) return undefined
  }
  return entries.slice(cursor.length)
}

/**
 * Drop the agent's own previous answer from a delta.
 *
 * The harness logs the assistant message this provider just produced, so the
 * next request's projection starts with that message. The agent already knows
 * what it said; only text that did not come from it belongs in the next prompt.
 * @param outgoing - entries after the forwarded prefix.
 * @param lastAnswer - text this provider streamed for the previous turn.
 * @returns the entries to send, without the agent's own echo.
 */
export function skipOwnAnswer(
  outgoing: readonly TranscriptEntry[],
  lastAnswer: string | undefined,
): readonly TranscriptEntry[] {
  const [first] = outgoing
  if (lastAnswer === undefined || first === undefined) return outgoing
  return first.role === 'assistant' && first.text === lastAnswer ? outgoing.slice(1) : outgoing
}

/** Role label rendered ahead of an entry inside a multi-entry prompt. */
function roleLabel(role: TranscriptRole): string {
  switch (role) {
    case 'user': return 'User: '
    case 'assistant': return 'Assistant: '
    case 'tool': return 'Tool result: '
    case 'system': return 'System instructions: '
  }
}

/**
 * Render forwarded entries into one prompt.
 * @param entries - entries to send; a lone user message keeps its raw text so
 *   the agent sees an ordinary next instruction rather than a transcript.
 * @returns the prompt text.
 */
export function renderPrompt(entries: readonly TranscriptEntry[]): string {
  const [only] = entries
  if (only !== undefined && entries.length === 1 && only.role === 'user') return only.text
  return entries.map(entry => `${roleLabel(entry.role)}${entry.text}`).join('\n\n')
}
