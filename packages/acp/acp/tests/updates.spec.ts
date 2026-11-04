import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import { ToolCallId, MessageId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolCallView } from '@deepseek-ai/dsh-tools'
import { assistantUpdates, toolCallUpdate, toolResultUpdate } from '../src/updates.ts'

/** Minimal committed assistant event for pure update projection tests. */
function assistantEvent(
  content: SessionEvent<'assistant/message'>['data']['message']['content'],
  usage?: SessionEvent<'assistant/message'>['data']['usage'],
): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    surfaceOp: 'append',
    seq: SessionSeq(0),
    time: 0,
    data: {
      stream: [],
      turn: 1,
      step: 1,
      message: {
        id: MessageId('message-1'),
        role: 'assistant',
        source: { kind: 'model', provider: 'mock', model: 'mock' },
        content,
      },
      ...usage === undefined ? {} : { usage },
    },
  }
}

/** Minimal committed tool-call event; arguments stay the raw model JSON string. */
function toolCallEvent(name: string, args: string): SessionEvent<'tool/call'> {
  return {
    type: 'tool/call',
    seq: SessionSeq(0),
    time: 0,
    data: { turn: 1, step: 1, callId: ToolCallId('call-1'), name, arguments: args },
  }
}

/** Agent stub carrying only the session workspace the projection resolves against. */
function agentWithCwd(cwd?: string): Agent {
  return { session: { header: { cwd } } } as unknown as Agent
}

/** Registry stub resolving definitions by name; undefined stands for an absent service. */
function ctxWithTools(definitions?: ReadonlyMap<string, ToolDefinition>): Context {
  const tools = definitions === undefined ? undefined : { get: (name: string) => definitions.get(name) }
  return { get: (name: string) => name === 'tools' ? tools : undefined, logger: { warn: vi.fn() } } as unknown as Context
}

/** Definition stub whose surface is only the declared render intent. */
function presenter(view: ToolCallView): { presentCall: ReturnType<typeof vi.fn> } {
  return { presentCall: vi.fn(() => view) }
}

/** A platform-absolute workspace anchor for the expected-path assertions. */
const WORK = resolve('/work')
const AGENT = agentWithCwd(WORK)

describe('standard ACP update projection', () => {
  it('omits empty reasoning, unsupported assistant blocks, and absent usage', async () => {
    const ctx = { get: () => undefined } as unknown as Context
    const session = { requestContext: () => undefined } as unknown as Session
    const event = assistantEvent([
      { type: 'reasoning', text: '' },
      { type: 'tool-call', id: ToolCallId('call-hidden'), name: 'hidden', arguments: '{}' },
    ])

    await expect(assistantUpdates(ctx, session, event)).resolves.toEqual([])
  })

  it('requires both measured usage and context capacity', async () => {
    const meter = { measure: vi.fn(() => ({ totalTokens: 7 })) }
    const withMeter = { get: (name: string) => name === 'tokenMeter' ? meter : undefined } as unknown as Context
    const withoutMeter = { get: () => undefined } as unknown as Context
    const withCapacity = { requestContext: () => ({ contextWindow: 100 }) } as unknown as Session
    const withoutCapacity = { requestContext: () => undefined } as unknown as Session
    const event = assistantEvent([{ type: 'text', text: 'done' }], { inputTokens: 1, outputTokens: 1 })

    expect((await assistantUpdates(withMeter, withoutCapacity, event)).map(update => update.sessionUpdate))
      .toEqual(['agent_message_chunk'])
    expect((await assistantUpdates(withoutMeter, withCapacity, event)).map(update => update.sessionUpdate))
      .toEqual(['agent_message_chunk'])
    expect(meter.measure).not.toHaveBeenCalled()
  })

  it('maps the tool-owned generic render intent', () => {
    const tool = presenter({
      card: 'generic',
      title: 'Read src/index.ts',
      kind: 'read',
      rawInput: 'src/index.ts',
      locations: [{ path: 'src/index.ts', line: 3 }, { path: '/abs/other.ts' }],
      content: [{ type: 'text', text: 'first 10 lines' }, { type: 'text', text: '' }, { type: 'reasoning', text: 'x' }],
    })
    const ctx = ctxWithTools(new Map([['read', tool as unknown as ToolDefinition]]))

    const call = toolCallUpdate(ctx, AGENT, toolCallEvent('read', '{"file_path":"src/index.ts"}'))

    expect(call).toEqual({
      toolCallId: 'call-1',
      title: 'Read src/index.ts',
      kind: 'read',
      status: 'in_progress',
      rawInput: 'src/index.ts',
      locations: [
        { path: resolve(WORK, 'src/index.ts'), line: 3 },
        { path: '/abs/other.ts' },
      ],
      content: [{ type: 'content', content: { type: 'text', text: 'first 10 lines' } }],
    })
    expect(tool.presentCall).toHaveBeenCalledWith({ file_path: 'src/index.ts' })
  })

  it('leaves locations unresolved when the session records no workspace', () => {
    const tool = presenter({
      card: 'generic',
      title: 'Read a file',
      locations: [{ path: 'rel/file.ts' }],
    })
    const ctx = ctxWithTools(new Map([['read', tool as unknown as ToolDefinition]]))

    const call = toolCallUpdate(ctx, agentWithCwd(undefined), toolCallEvent('read', '{}'))

    expect(call.locations).toEqual([{ path: 'rel/file.ts' }])
  })

  it('maps a terminal intent to an execute call carrying the description', () => {
    const tool = presenter({ card: 'terminal', title: 'npm test', description: 'Run the suite', cwd: 'subdir' })
    const ctx = ctxWithTools(new Map([['bash', tool as unknown as ToolDefinition]]))

    expect(toolCallUpdate(ctx, AGENT, toolCallEvent('bash', '{"command":"npm test"}'))).toEqual({
      toolCallId: 'call-1',
      title: 'npm test',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'npm test' },
      content: [{ type: 'content', content: { type: 'text', text: 'Run the suite' } }],
    })

    const plain = presenter({ card: 'terminal', title: 'ls' })
    const plainCtx = ctxWithTools(new Map([['bash', plain as unknown as ToolDefinition]]))
    expect(toolCallUpdate(plainCtx, AGENT, toolCallEvent('bash', '{}'))).toEqual({
      toolCallId: 'call-1',
      title: 'ls',
      kind: 'execute',
      status: 'in_progress',
      rawInput: {},
    })
  })

  it('maps a diff intent to edit kind and absolute-path diff entries', () => {
    const tool = presenter({
      card: 'diff',
      title: 'Write foo.txt',
      diffs: [{ path: 'foo.txt', oldText: null, newText: 'hello' }],
      locations: [{ path: 'foo.txt' }],
    })
    const ctx = ctxWithTools(new Map([['write', tool as unknown as ToolDefinition]]))

    expect(toolCallUpdate(ctx, AGENT, toolCallEvent('write', '{"file_path":"foo.txt"}'))).toEqual({
      toolCallId: 'call-1',
      title: 'Write foo.txt',
      kind: 'edit',
      status: 'in_progress',
      rawInput: { file_path: 'foo.txt' },
      locations: [{ path: resolve(WORK, 'foo.txt') }],
      content: [{ type: 'diff', path: resolve(WORK, 'foo.txt'), oldText: null, newText: 'hello' }],
    })

    const bare = presenter({ card: 'diff', title: 'Write bar.txt', diffs: [{ path: 'bar.txt', oldText: 'x', newText: 'y' }] })
    const bareCtx = ctxWithTools(new Map([['write', bare as unknown as ToolDefinition]]))
    const bareCall = toolCallUpdate(bareCtx, AGENT, toolCallEvent('write', '{}'))
    expect('locations' in bareCall).toBe(false)
    expect(bareCall.content).toEqual([{ type: 'diff', path: resolve(WORK, 'bar.txt'), oldText: 'x', newText: 'y' }])
  })

  it('projects a minimal generic intent without invented fields', () => {
    const tool = presenter({ card: 'generic', title: 'Do a thing' })
    const ctx = ctxWithTools(new Map([['act', tool as unknown as ToolDefinition]]))

    expect(toolCallUpdate(ctx, AGENT, toolCallEvent('act', '{"a":1}'))).toEqual({
      toolCallId: 'call-1',
      title: 'Do a thing',
      kind: 'other',
      status: 'in_progress',
      rawInput: { a: 1 },
    })
  })

  it('falls back to the generic card without a registry, definition, or intent', () => {
    const noRegistry = ctxWithTools(undefined)
    const noDefinition = ctxWithTools(new Map())
    const noIntent = ctxWithTools(new Map([['mystery', {} as unknown as ToolDefinition]]))
    const event = toolCallEvent('mystery', '{"a":1}')
    const expected = {
      toolCallId: 'call-1',
      title: 'mystery',
      kind: 'other',
      status: 'in_progress',
      rawInput: { a: 1 },
    }

    expect(toolCallUpdate(noRegistry, AGENT, event)).toEqual(expected)
    expect(toolCallUpdate(noDefinition, AGENT, event)).toEqual(expected)
    expect(toolCallUpdate(noIntent, AGENT, event)).toEqual(expected)
  })

  it('skips the presenter and preserves the raw string on malformed arguments', () => {
    const tool = presenter({ card: 'generic', title: 'unused' })
    const ctx = ctxWithTools(new Map([['broken', tool as unknown as ToolDefinition]]))

    const call = toolCallUpdate(ctx, AGENT, toolCallEvent('broken', '{'))

    expect(call).toMatchObject({ title: 'broken', kind: 'other', rawInput: '{' })
    expect(tool.presentCall).not.toHaveBeenCalled()
  })

  it('falls back when the presenter throws', () => {
    const tool = { presentCall: vi.fn(() => { throw new Error('bad intent') }) }
    const ctx = ctxWithTools(new Map([['flaky', tool as unknown as ToolDefinition]]))

    expect(toolCallUpdate(ctx, AGENT, toolCallEvent('flaky', '{}'))).toMatchObject({
      title: 'flaky',
      kind: 'other',
      rawInput: {},
    })
  })

  it('preserves malformed tool input and projects a failed result without hidden content', async () => {
    const result = await toolResultUpdate({ get: () => undefined } as unknown as Context, {
      type: 'tool/result',
      surfaceOp: 'append',
      seq: SessionSeq(0),
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: MessageId('tool-message'),
          role: 'tool',
          toolCallId: ToolCallId('call-bad'),
          isError: true,
          source: { kind: 'tool', callId: ToolCallId('call-bad') },
          content: [{ type: 'reasoning', text: 'hidden' }],
        },
      },
    })

    expect(result).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-bad',
      status: 'failed',
      content: [],
    })
  })
})
