import { afterEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

// TODO: no recorded snapshots/acp scenario covers session/fork. Recording needs
// a POSIX checkout (the pinned ACP tool roster differs on Windows) and a
// DEEPSEEK_API_KEY; these package tests and the real-key acceptance scenario
// cover it until then.
describe('ACP session fork', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  /** Create one sourced session and return its id. */
  async function sourceSession(text = 'source question'): Promise<string> {
    const created = await harness!.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness!.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text }] })
    return created.sessionId
  }

  it('forks the latest completed turn of a closed session and continues from its history', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('answer'), textResponse('continued')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const sourceId = await sourceSession()
    await harness.client.closeSession({ sessionId: sourceId })

    const forked = await harness.client.forkSession({ sessionId: sourceId, cwd: process.cwd() })
    expect(forked.sessionId).not.toBe(sourceId)
    expect(forked.configOptions?.length).toBeGreaterThan(0)

    const child = harness.ctx.sessions.get(SessionId(forked.sessionId))
    expect(child?.header.isSeeded).toBe(true)
    expect(child?.inheritedEventCount).toBeGreaterThan(0)

    await harness.client.prompt({ sessionId: forked.sessionId, prompt: [{ type: 'text', text: 'continue' }] })
    const request = JSON.stringify(harness.adapter.requests.at(-1)?.messages)
    expect(request).toContain('source question')
    expect(request).toContain('answer')
    expect(request).toContain('continue')
  })

  it('forks a live session without closing the source', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('answer'), textResponse('continued')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const sourceId = await sourceSession()

    const forked = await harness.client.forkSession({ sessionId: sourceId, cwd: process.cwd() })
    expect(forked.sessionId).not.toBe(sourceId)

    await harness.client.prompt({ sessionId: forked.sessionId, prompt: [{ type: 'text', text: 'continue' }] })
    expect(JSON.stringify(harness.adapter.requests.at(-1)?.messages)).toContain('source question')
  })

  it('rejects a session without a completed turn', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.closeSession({ sessionId: created.sessionId })

    await expect(harness.client.forkSession({ sessionId: created.sessionId, cwd: process.cwd() }))
      .rejects.toThrow(/no completed turn/)
  })

  it('rejects a cwd that does not match the source workspace', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('answer')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const sourceId = await sourceSession()
    await harness.client.closeSession({ sessionId: sourceId })

    await expect(harness.client.forkSession({ sessionId: sourceId, cwd: tmpdir() }))
      .rejects.toThrow(/cwd does not match/)
  })
})
