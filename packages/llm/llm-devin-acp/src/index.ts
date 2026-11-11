/**
 * Devin models as a harness LLM provider.
 *
 * The plugin registers one provider route whose model catalog is discovered
 * live from the Devin ACP agent, and whose model calls are answered by that
 * same agent in its own process. It is the model-picker counterpart of
 * `dsh-subagent-acp`: where the subagent backend delegates a task, this
 * provider lets a harness session run on Devin's own models.
 *
 * @module @deepseek-ai/dsh-llm-devin-acp
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { DevinAcpAdapter, type ResolvedDevinAcpConfig } from './adapter.ts'

export const name = 'llm-devin-acp'
export const inject = ['llm', 'subprocess']

/** Config: how to run the Devin agent that backs the provider route. */
export interface Config {
  /** Provider route name offered to model selectors (default `devin`). */
  providerName: string
  /** Human-readable provider name shown beside its models (default `Devin`). */
  displayName: string
  /** The Devin executable to spawn. */
  command: string
  /** Arguments passed to {@link command} (default `['acp']`). */
  args: string[]
  /**
   * Extra environment variables for the agent process. Forwarded on top of a
   * credential-scrubbed copy of the parent environment, so an explicit value
   * reaches the agent while ambient secrets do not leak implicitly.
   */
  env: Record<string, string>
  /**
   * Working directory for agent processes and their sessions. Omitted uses the
   * harness process directory, because a model request carries no workspace of
   * its own.
   */
  cwd?: string
  /**
   * How the agent's own `session/request_permission` prompts are answered:
   * `reject` (default — decline every prompt) or `allow` (approve via the first
   * `allow_once` or `allow_always` option). No prompt is surfaced to a human.
   */
  permission: 'allow' | 'reject'
  /** Session configuration option id that selects the model (default `model`). */
  modelConfigId: string
  /** How long a discovered model catalog stays authoritative, in milliseconds (default 600000). */
  discoveryTtlMs: number
  /** Bound for one catalog discovery, including agent startup, in milliseconds (default 30000). */
  discoveryTimeoutMs: number
  /** Idle agent sessions kept alive (default 4). */
  maxSessions: number
  /** Idle time after which an agent session is released, in milliseconds (default 1800000). */
  sessionIdleMs: number
  /** Grace after stdin EOF for an agent to flush and exit, in milliseconds (default 6000). */
  disposeEofGraceMs: number
  /** Termination grace for the subprocess seam, in milliseconds (default 3000). */
  disposeGraceMs: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('devin'),
  displayName: z.string().default('Devin'),
  command: z.string().required(),
  args: z.array(z.string()).default(['acp']),
  env: z.dict(z.string()).default({}),
  cwd: z.string(),
  permission: z.union(['allow', 'reject'] as const).default('reject'),
  modelConfigId: z.string().default('model'),
  discoveryTtlMs: z.number().default(600_000),
  discoveryTimeoutMs: z.number().default(30_000),
  maxSessions: z.number().default(4),
  sessionIdleMs: z.number().default(1_800_000),
  disposeEofGraceMs: z.number().default(6_000),
  disposeGraceMs: z.number().default(3_000),
})

/** Reject a value no timer or capacity check can use. */
function assertPositiveFinite(field: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-devin-acp: ${field} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/** Reject a session cap that cannot hold one session. */
function assertSessionCap(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('llm-devin-acp: maxSessions must be a positive integer')
  }
}

/**
 * Register the Devin provider route and release its agent sessions on unload.
 * @param ctx - context carrying the LLM registry and the subprocess seam.
 * @param config - resolved provider configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery has already filled every defaulted field.
  const resolved = config as ResolvedDevinAcpConfig
  assertPositiveFinite('discoveryTtlMs', resolved.discoveryTtlMs)
  assertPositiveFinite('discoveryTimeoutMs', resolved.discoveryTimeoutMs)
  assertPositiveFinite('sessionIdleMs', resolved.sessionIdleMs)
  assertPositiveFinite('disposeEofGraceMs', resolved.disposeEofGraceMs)
  assertPositiveFinite('disposeGraceMs', resolved.disposeGraceMs)
  assertSessionCap(resolved.maxSessions)
  if (resolved.providerName.length === 0) throw new Error('llm-devin-acp: providerName must be non-empty')
  const adapter = new DevinAcpAdapter(ctx, resolved)
  ctx.llm.registerAdapter([resolved.providerName], adapter)
  ctx.effect(() => () => adapter.close())
}
