import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, type BridgeHarness } from './harness.ts'
import { replayUpdates } from '../src/replay.ts'

describe('ACP history replay projection', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  /** Create one live session and return its exact Agent. */
  async function liveAgent(): Promise<{ agent: Agent; sessionId: string }> {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(created.sessionId))
    if (agent === undefined) throw new Error('missing live agent')
    return { agent, sessionId: created.sessionId }
  }

  it('projects visible tool lifecycles and the latest plan', async () => {
    const { agent } = await liveAgent()
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: ToolCallId('call-9'),
      name: 'bash',
      arguments: '{}',
    })
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('call-9'),
        content: [{ type: 'text', text: 'done' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    agent.session.append('todo/write', {
      todos: [{ content: 'pending task', status: 'pending' }],
    })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const updates = await replayUpdates(harness!.ctx, agent, agent.session.snapshotEvents())

    expect(updates).toEqual([
      expect.objectContaining({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-9',
        status: 'in_progress',
      }),
      expect.objectContaining({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-9',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
      }),
      {
        sessionUpdate: 'plan',
        entries: [{ content: 'pending task', status: 'pending', priority: 'medium' }],
      },
    ])
  })

  it('replays a replacement surface instead of its shadowed original', async () => {
    const { agent } = await liveAgent()
    agent.session.append('turn/start', { turn: 1 })
    const original = agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'original question' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'replacement summary' }],
      source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq },
      sourceEventSeqs: [original.seq],
    })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const updates = await replayUpdates(harness!.ctx, agent, agent.session.snapshotEvents())

    expect(updates).toEqual([
      expect.objectContaining({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'replacement summary' },
      }),
    ])
  })
})
