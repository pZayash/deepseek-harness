import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

// TODO: no recorded snapshots/acp scenario covers session/delete. Recording
// needs a POSIX checkout (the pinned ACP tool roster differs on Windows) and a
// DEEPSEEK_API_KEY; these delivery tests cover ordering until then.
describe('ACP session delete', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('deletes a closed session and removes it from later operations', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('answer')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'hello' }] })
    await harness.client.closeSession({ sessionId: created.sessionId })

    await expect(harness.client.deleteSession({ sessionId: created.sessionId })).resolves.toEqual({})
    await expect(harness.client.listSessions({})).resolves.toEqual({ sessions: [] })
    await expect(harness.client.loadSession({
      sessionId: created.sessionId,
      cwd: process.cwd(),
      mcpServers: [],
    })).rejects.toThrow(/not loadable/)
    await expect(harness.client.deleteSession({ sessionId: created.sessionId }))
      .rejects.toThrow(/not deletable/)
  })

  it('rejects an active session', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(harness.client.deleteSession({ sessionId: created.sessionId }))
      .rejects.toThrow(/is active/)
    await harness.client.closeSession({ sessionId: created.sessionId })
  })

  it('deletes a root session together with its subagent descendants', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const root = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.closeSession({ sessionId: root.sessionId })

    const child = await harness.ctx.agents.create({
      sessionId: SessionId('subagent-child'),
      meta: {
        cwd: process.cwd(),
        parentSession: SessionId(root.sessionId),
        origin: 'subagent',
      },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await harness.ctx.sessions.flush(child.agent.session)
    await child.dispose()

    await harness.client.deleteSession({ sessionId: root.sessionId })

    expect(await harness.ctx.sessionPersistence.stat(SessionId('subagent-child'))).toBeUndefined()
    expect(await harness.ctx.sessionPersistence.stat(SessionId(root.sessionId))).toBeUndefined()
  })
})
