import type { PermissionCatalog, PresetOption } from '@deepseek-ai/dsh-permission-presets'
import type { Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { AcpModeConfigError, AcpModeControl, MODE_CONFIG_ID, type AcpModePermissions } from '../src/mode-control.ts'

const session = { id: 'mode-control' } as Session

/** One catalog entry, omitting the description key when the source does. */
function preset(value: string, name: string, description?: string): PresetOption {
  return { value, name, ...description === undefined ? {} : { description } }
}

/** Permission-preset double whose current value follows a successful switch. */
function fakePermissions(initial: string): AcpModePermissions & { switches: string[]; current: () => string } {
  const switches: string[] = []
  const names = ['workspace-write', 'danger-full-access'] as const
  let currentValue = initial
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
    current: () => currentValue,
    optionOf: name => preset(name, name === 'custom' ? 'Custom' : name, 'Derived state.'),
    names,
    set: (_session, name) => {
      switches.push(name)
      currentValue = name
    },
    switches,
  }
}

describe('ACP mode configuration control', () => {
  it('projects the preset catalog with the session current selection', () => {
    const permissions = fakePermissions('workspace-write')
    const control = new AcpModeControl(permissions, session)

    expect(control.options()).toEqual([{
      id: MODE_CONFIG_ID,
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'workspace-write',
      options: [
        { value: 'workspace-write', name: 'Workspace write', description: 'Write inside the workspace.' },
        { value: 'danger-full-access', name: 'Full access' },
      ],
    }])
  })

  it('labels a derived custom selection without offering it as a target', () => {
    const control = new AcpModeControl(fakePermissions('custom'), session)

    expect(control.options()).toEqual([{
      id: MODE_CONFIG_ID,
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'custom',
      options: [
        { value: 'custom', name: 'Custom', description: 'Derived state.' },
        { value: 'workspace-write', name: 'Workspace write', description: 'Write inside the workspace.' },
        { value: 'danger-full-access', name: 'Full access' },
      ],
    }])
  })

  it('switches an advertised preset and reports the resulting state', () => {
    const permissions = fakePermissions('workspace-write')
    const control = new AcpModeControl(permissions, session)

    const [option] = control.set('danger-full-access')
    expect(permissions.switches).toEqual(['danger-full-access'])
    expect(option?.currentValue).toBe('danger-full-access')
  })

  it('rejects a non-select value and an unknown preset without switching', () => {
    const permissions = fakePermissions('workspace-write')
    const control = new AcpModeControl(permissions, session)

    expect(() => control.set(false)).toThrow(AcpModeConfigError)
    expect(() => control.set(false)).toThrow(/requires a select value/)
    expect(() => control.set('custom')).toThrow(/unknown mode: custom/)
    expect(permissions.switches).toEqual([])
  })
})
