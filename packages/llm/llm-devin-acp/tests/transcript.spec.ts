/** Pure transcript projection behavior for the Devin ACP provider. */

import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-tools'
import {
  createAssistantMessage,
  createDeveloperMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { renderPrompt, skipOwnAnswer, tailAfter, transcriptEntries } from '../src/transcript.ts'

/** One user message with plain text and a stable identity for assertions. */
function user(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** One assistant message with plain text. */
function assistant(text: string) {
  return createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'devin', model: 'm' } })
}

describe('transcript projection', () => {
  it('drops harness instructions, developer updates, and empty answers', () => {
    const question = user('do the thing')
    const entries = transcriptEntries([
      createSystemMessage('harness instructions'),
      createDeveloperMessage({ content: [{ type: 'tool-addition', toolName: 'shell' }], source: { kind: 'tool-registry' } }),
      question,
      assistant(''),
    ], false)

    expect(entries).toEqual([{ key: question.id, role: 'user', text: 'do the thing' }])
  })

  it('includes the system prompt for one-shot auxiliary requests', () => {
    const entries = transcriptEntries([
      createSystemMessage('Produce a title.'),
      user('do the thing'),
    ], true)

    expect(entries.map(entry => entry.role)).toEqual(['system', 'user'])
  })

  it('renders attachments as text handles and marks failed tool results', () => {
    const entries = transcriptEntries([
      createUserMessage({
        content: [
          { type: 'text', text: 'look at these' },
          {
            type: 'image',
            attachment: {
              attachmentId: AttachmentId('image-1'),
              mediaType: 'image/png',
              bytes: 10,
              width: 1,
              height: 1,
              name: 'screenshot.png',
            },
          },
          {
            type: 'file',
            attachment: { attachmentId: AttachmentId('file-1'), name: 'notes.txt', bytes: 4 },
          },
        ],
        source: { kind: 'user' },
      }),
      createToolResultMessage({ callId: ToolCallId('call-1'), content: [{ type: 'text', text: 'boom' }], isError: true }),
    ], false)

    expect(entries[0]?.text).toBe('look at these\n\n[image: screenshot.png]\n\n[file: notes.txt]')
    expect(entries[1]?.text).toBe('(error) boom')
  })

  it('sends a lone user message raw and labels a multi-entry replay', () => {
    const single = transcriptEntries([user('just this')], false)
    expect(renderPrompt(single)).toBe('just this')

    const replay = transcriptEntries([user('question'), assistant('answer'), user('next')], false)
    expect(renderPrompt(replay)).toBe('User: question\n\nAssistant: answer\n\nUser: next')
  })

  it('matches a forwarded prefix and rejects a diverged conversation', () => {
    const entries = transcriptEntries([user('one'), assistant('two'), user('three')], false)
    const cursor = entries.slice(0, 2).map(entry => entry.key)

    expect(tailAfter(entries, cursor)?.map(entry => entry.text)).toEqual(['three'])
    expect(tailAfter(entries, ['unrelated'])).toBeUndefined()
    expect(tailAfter(entries, [...cursor, 'extra'])).toBeUndefined()
  })

  it('drops the agent own answer from a delta', () => {
    const entries = transcriptEntries([assistant('same answer'), user('next')], false)
    expect(skipOwnAnswer(entries, 'same answer').map(entry => entry.role)).toEqual(['user'])
    expect(skipOwnAnswer(entries, 'other answer')).toEqual(entries)
    expect(skipOwnAnswer(entries, undefined)).toEqual(entries)
  })
})
