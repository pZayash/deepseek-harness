/** Standard ACP session configuration over one Session's permission preset. */

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { PermissionCatalog, PresetOption } from '@deepseek-ai/dsh-permission-presets'
import type { Session } from '@deepseek-ai/dsh-session'

/** Standard option id carrying the Session's permission preset (`mode` category). */
export const MODE_CONFIG_ID = 'mode'

/**
 * The permission-preset surface the mode option needs. Declaring the subset
 * keeps the ACP bridge independent of the preset service's remote protocol and
 * lets a composition without permission presets omit the option entirely.
 */
export interface AcpModePermissions {
  /** The process-level selectable catalog. */
  catalog(): PermissionCatalog
  /** The Session's effective preset, including the derived `custom` value. */
  current(session: Session): string
  /** Client presentation for one catalog value or the derived `custom` state. */
  optionOf(name: string): PresetOption
  /** Every switchable preset name. */
  readonly names: readonly string[]
  /** Record and apply one preset for a Session. */
  set(session: Session, name: string): void
}

/** Caller-correctable session mode failure. */
export class AcpModeConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpModeConfigError'
  }
}

/** Map a catalog entry to the standard select option shape, keeping optional copy optional. */
function selectOption(option: PresetOption): { value: string; name: string; description?: string } {
  return {
    value: option.value,
    name: option.name,
    ...option.description === undefined ? {} : { description: option.description },
  }
}

/**
 * Project and mutate one Agent Session's permission preset through the standard
 * ACP `mode` configuration option. The Session's durable preset selection is
 * the only state; the sandbox and approval knobs it writes apply to the same
 * Agent immediately, so a switch needs no new turn to take effect.
 *
 * This stays an ACP-side adapter on purpose. The preset service keeps owning
 * the catalog and the single write path; this file only renames that surface for
 * the protocol. ACP clients (bb's provider-acp among them) map the `mode`
 * category onto their composer mode selector and send `session/set_config_option`
 * — the same standard route the model and reasoning selectors use — so exposing
 * presets here adds no private method, `_meta`, or wire field.
 */
export class AcpModeControl {
  constructor(
    private readonly permissions: AcpModePermissions,
    private readonly session: Session,
  ) {}

  /**
   * Return the selectable presets and the Session's current one. A derived
   * `custom` value labels the current state but is never offered as a target.
   * @returns the standard `mode` configuration option.
   */
  options(): SessionConfigOption[] {
    const current = this.permissions.current(this.session)
    const options = this.permissions.catalog().options.map(selectOption)
    if (!options.some(option => option.value === current)) {
      options.unshift(selectOption(this.permissions.optionOf(current)))
    }
    return [{
      id: MODE_CONFIG_ID,
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: current,
      options,
    }]
  }

  /**
   * Switch the Session to one advertised preset and return the resulting state.
   * @param value - opaque selected value from a previous option state.
   * @returns the standard `mode` configuration option after the switch.
   */
  set(value: unknown): SessionConfigOption[] {
    if (typeof value !== 'string') throw new AcpModeConfigError('mode requires a select value')
    if (!this.permissions.names.includes(value)) throw new AcpModeConfigError(`unknown mode: ${value}`)
    this.permissions.set(this.session, value)
    return this.options()
  }
}
