import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

// TODO: no snapshots/acp scenario drives a real todo_write turn, so recorded
// replay does not yet cover `plan` updates; recording needs an owner with
// DEEPSEEK_API_KEY.
describe('ACP plan updates', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('emits the committed todo list, then clears it at the next turn boundary', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('done')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    agent.session.append('todo/write', {
      todos: [
        { content: 'first task', status: 'in_progress' },
        { content: 'second task', status: 'pending' },
      ],
    })

    // Prompt settlement drains the update chain, so this observes the whole
    // order: the emitted plan, the turn-start clearing, then the turn output.
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    expect(harness.updates).toEqual([
      {
        sessionUpdate: 'plan',
        entries: [
          { content: 'first task', status: 'in_progress', priority: 'medium' },
          { content: 'second task', status: 'pending', priority: 'medium' },
        ],
      },
      { sessionUpdate: 'plan', entries: [] },
      expect.objectContaining({ sessionUpdate: 'agent_message_chunk' }),
      expect.objectContaining({ sessionUpdate: 'usage_update' }),
    ])
  })

  it('emits no plan for a session whose composition never writes todos', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('done')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    await vi.waitFor(() => { expect(harness!.updates.at(-1)?.sessionUpdate).toBe('usage_update') })

    expect(harness.updates.some(update => update.sessionUpdate === 'plan')).toBe(false)
  })
})
