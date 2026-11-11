import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

// TODO: no recorded snapshots/acp scenario covers session/load. Recording needs
// a POSIX checkout (the pinned ACP tool roster differs on Windows) and a
// DEEPSEEK_API_KEY; these delivery tests cover replay ordering until then.
describe('ACP session load', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('replays the committed conversation before answering session/load', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('answer')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'source question' }] })
    await harness.client.closeSession({ sessionId: created.sessionId })
    harness.updates.length = 0

    const loaded = await harness.client.loadSession({
      sessionId: created.sessionId,
      cwd: process.cwd(),
      mcpServers: [],
    })

    expect(loaded.configOptions?.length).toBeGreaterThan(0)
    expect(harness.updates).toHaveLength(2)
    expect(harness.updates[0]).toMatchObject({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'source question' },
    })
    expect(harness.updates[1]).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'answer' },
    })
  })

  it('rejects an active session and a mismatched cwd', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(harness.client.loadSession({
      sessionId: created.sessionId,
      cwd: process.cwd(),
      mcpServers: [],
    })).rejects.toThrow(/already active/)

    await harness.client.closeSession({ sessionId: created.sessionId })
    await expect(harness.client.loadSession({
      sessionId: created.sessionId,
      cwd: '/',
      mcpServers: [],
    })).rejects.toThrow(/cwd does not match/)
  })
})
