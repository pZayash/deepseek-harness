import { afterEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { makeBridgeHarness, type BridgeHarness } from './harness.ts'

describe('ACP machine permission policy', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  async function ownedRequest(overrides: Partial<ApprovalRequest> = {}): Promise<ApprovalRequest> {
    if (harness === undefined) throw new Error('missing harness')
    await harness.ctx.plugin(ApprovalService)
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('step/start', { turn: 1, step: 1 })
    agent.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('call-9'), name: 'bash', arguments: '{}' })
    return { agent, toolName: 'bash', callId: ToolCallId('call-9'), ...overrides }
  }

  it('maps the two advertised one-shot choices', async () => {
    harness = await makeBridgeHarness()
    harness.onPermission = () => {
      expect(harness?.sessionUpdates.at(-1)?.update).toMatchObject({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-9',
      })
      return { outcome: { outcome: 'selected', optionId: 'allow-once' } }
    }
    const request = await ownedRequest()
    await expect(harness.ctx.approval.request(request)).resolves.toBe('allowed-once')
    expect(harness.permissionRequests[0]).toMatchObject({
      sessionId: request.agent.session.id,
      toolCall: {
        toolCallId: 'call-9',
        title: 'bash',
        kind: 'other',
        status: 'in_progress',
        rawInput: {},
      },
      options: [
        { optionId: 'allow-once', kind: 'allow_once' },
        { optionId: 'reject-once', kind: 'reject_once' },
      ],
    })

    harness.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'reject-once' } })
    await expect(harness.ctx.approval.request(request)).resolves.toBe('rejected')
  })

  it('maps cancellation and unknown choices without granting access', async () => {
    harness = await makeBridgeHarness()
    const request = await ownedRequest()
    await expect(harness.ctx.approval.request(request)).resolves.toBe('cancelled')
    harness.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'unknown-grant' } })
    await expect(harness.ctx.approval.request(request)).resolves.toBe('rejected')
  })

  it('fails closed when the client errors the permission request', async () => {
    harness = await makeBridgeHarness()
    const request = await ownedRequest()
    harness.onPermission = () => { throw new Error('client gone') }
    await expect(harness.ctx.approval.request(request)).resolves.toBe('unavailable')
  })

  it('delegates a same-id foreign agent', async () => {
    harness = await makeBridgeHarness()
    const request = await ownedRequest()
    const events = [{ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }]
    const foreign = {
      session: {
        id: request.agent.session.id,
        seq: events.length,
        eventAt: (seq: number) => events[seq],
        snapshotEvents: () => events,
        append: () => ({}),
      },
    } as unknown as Agent
    await expect(harness.ctx.approval.request({ agent: foreign, toolName: 'bash', callId: ToolCallId('call') }))
      .resolves.toBe('unavailable')
    expect(harness.permissionRequests).toHaveLength(0)
  })

  it('delegates requests that have no protocol tool-call identity', async () => {
    harness = await makeBridgeHarness()
    const request = await ownedRequest()
    await expect(harness.ctx.approval.request({ agent: request.agent, toolName: request.toolName }))
      .resolves.toBe('unavailable')
    expect(harness.permissionRequests).toHaveLength(0)
  })

  it('embeds the tool-owned render intent in the permission card', async () => {
    harness = await makeBridgeHarness()
    await harness.ctx.plugin(ApprovalService)
    harness.ctx.tools.register({
      name: 'guarded',
      description: 'A guarded action',
      parameters: { type: 'object' },
      output: { schema: { type: 'object' }, render: () => [] },
      execute: () => Promise.resolve({}),
      presentCall: () => ({
        card: 'generic',
        title: 'Guarded action on src/a.ts',
        kind: 'edit',
        locations: [{ path: 'src/a.ts' }],
      }),
    } as ToolDefinition)
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('step/start', { turn: 1, step: 1 })
    agent.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('call-7'), name: 'guarded', arguments: '{}' })

    await expect(harness.ctx.approval.request({ agent, toolName: 'guarded', callId: ToolCallId('call-7') }))
      .resolves.toBe('cancelled')
    expect(harness.permissionRequests[0]?.toolCall).toMatchObject({
      toolCallId: 'call-7',
      title: 'Guarded action on src/a.ts',
      kind: 'edit',
      status: 'in_progress',
      locations: [{ path: resolve(process.cwd(), 'src/a.ts') }],
    })
  })

  it('sends only the call identity once the tool call leaves flight', async () => {
    harness = await makeBridgeHarness()
    const request = await ownedRequest()
    const session = request.agent.session
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('call-9'),
        content: [{ type: 'text', text: 'done' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })

    await expect(harness.ctx.approval.request(request)).resolves.toBe('cancelled')
    expect(harness.permissionRequests[0]?.toolCall).toEqual({ toolCallId: 'call-9' })

    await expect(harness.ctx.approval.request({ agent: request.agent, toolName: 'bash', callId: ToolCallId('call-8') }))
      .resolves.toBe('cancelled')
    expect(harness.permissionRequests[1]?.toolCall).toEqual({ toolCallId: 'call-8' })

    session.append('tool/call', { turn: 1, step: 2, callId: ToolCallId('call-10'), name: 'bash', arguments: '{}' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    await expect(harness.ctx.approval.request({ agent: request.agent, toolName: 'bash', callId: ToolCallId('call-10') }))
      .resolves.toBe('cancelled')
    expect(harness.permissionRequests[2]?.toolCall).toEqual({ toolCallId: 'call-10' })
  })
})
