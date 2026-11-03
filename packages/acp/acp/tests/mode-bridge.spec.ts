import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { PermissionCatalog, PresetOption } from '@deepseek-ai/dsh-permission-presets'
import type { Session } from '@deepseek-ai/dsh-session'
import type { AcpModePermissions } from '../src/mode-control.ts'
import { makeBridgeHarness, type BridgeHarness } from './harness.ts'

/** One catalog entry, omitting the description key when the source does. */
function preset(value: string, name: string, description?: string): PresetOption {
  return { value, name, ...description === undefined ? {} : { description } }
}

/** Permission-preset double whose current value follows a successful switch. */
function presetService(): AcpModePermissions & { readonly switches: string[] } {
  const switches: string[] = []
  let currentValue = 'workspace-write'
  const catalog: PermissionCatalog = {
    options: [
      preset('workspace-write', 'Workspace write', 'Write inside the workspace.'),
      preset('danger-full-access', 'Full access'),
    ],
    defaultOptions: [],
    defaultPreset: 'workspace-write',
  }
  return {
    catalog: () => catalog,
    current: (_session: Session) => currentValue,
    optionOf: name => preset(name, name === 'custom' ? 'Custom' : name, 'Derived state.'),
    names: ['workspace-write', 'danger-full-access'],
    set: (_session, name) => {
      switches.push(name)
      currentValue = name
    },
    switches,
  }
}

describe('ACP mode configuration over the bridge', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('advertises the permission presets as the mode option and switches them', async () => {
    const permissions = presetService()
    harness = await makeBridgeHarness({ permissions })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const advertised = (created.configOptions ?? []).find(option => option.id === 'mode')
    expect(advertised?.category).toBe('mode')
    expect(advertised?.currentValue).toBe('workspace-write')

    const switched = await harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'mode',
      value: 'danger-full-access',
    })
    expect(switched.configOptions.find(option => option.id === 'mode')?.currentValue).toBe('danger-full-access')
    expect(permissions.switches).toEqual(['danger-full-access'])

    await expect(harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'mode',
      value: 'missing',
    })).rejects.toThrow(/unknown mode: missing/)
  })
})
