import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

describe('ACP session listing titles', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  /** Create, prompt, and close one session so it becomes listable. */
  async function closedSession(): Promise<string> {
    await harness!.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness!.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness!.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'persist me' }] })
    await harness!.client.closeSession({ sessionId: created.sessionId })
    return created.sessionId
  }

  it('publishes the cached title of a closed listable session', async () => {
    harness = await makeBridgeHarness({
      script: [textResponse('answer')],
      projectionCache: {
        cachedSnapshot: () => ({ asOfSeq: -1, values: { title: 'Refactor auth' } }),
        cachedPredecessorTitle: () => undefined,
      },
    })
    const sessionId = await closedSession()

    await expect(harness.client.listSessions({})).resolves.toEqual({
      sessions: [{ sessionId, cwd: process.cwd(), title: 'Refactor auth' }],
    })
  })

  it('falls back to a predecessor title for a migrated session', async () => {
    harness = await makeBridgeHarness({
      script: [textResponse('answer')],
      projectionCache: {
        cachedSnapshot: () => undefined,
        cachedPredecessorTitle: () => ({ asOfSeq: -1, values: { title: 'Migrated title' } }),
      },
    })
    const sessionId = await closedSession()

    await expect(harness.client.listSessions({})).resolves.toEqual({
      sessions: [{ sessionId, cwd: process.cwd(), title: 'Migrated title' }],
    })
  })

  it('omits an empty cached title', async () => {
    harness = await makeBridgeHarness({
      script: [textResponse('answer')],
      projectionCache: {
        cachedSnapshot: () => ({ asOfSeq: -1, values: { title: '' } }),
        cachedPredecessorTitle: () => undefined,
      },
    })
    const sessionId = await closedSession()

    await expect(harness.client.listSessions({})).resolves.toEqual({
      sessions: [{ sessionId, cwd: process.cwd() }],
    })
  })
})
