/**
 * Live model discovery for the Devin ACP provider.
 *
 * The agent, not this package, knows which models the signed-in account may
 * select: it publishes them as the `model` session configuration option when a
 * session is created. Discovery therefore opens one throwaway session, reads
 * that option, deletes the session again, and caches the result, so a UI model
 * list neither goes stale between Devin releases nor accumulates probe sessions
 * in the user's session history.
 *
 * @module @deepseek-ai/dsh-llm-devin-acp/catalog
 */


import type { SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk'
import { DevinAcpFailure, openAcpSession, type AcpAgentSpec } from './acp.ts'

/** One model the agent advertised in its model configuration option. */
export interface CatalogModel {
  /** Model id accepted by `session/set_config_option` for the model option. */
  readonly id: string
  /** Agent-authored display name. */
  readonly name: string
  /** Agent-authored selector description, when it publishes one. */
  readonly description?: string

}

/** A cached discovery result and the moment it was read. */
interface CatalogCache {
  readonly models: readonly CatalogModel[]
  readonly fetchedAt: number
}



/** Flatten a select option's values, including grouped ones. */
function selectValues(option: SessionConfigOption): SessionConfigSelectOption[] {
  if (option.type !== 'select') return []
  const values: SessionConfigSelectOption[] = []
  for (const candidate of option.options) {
    if ('group' in candidate) values.push(...candidate.options)
    else values.push(candidate)
  }
  return values
}

/** Translate one advertised value into a model entry. */
function catalogModel(value: SessionConfigSelectOption): CatalogModel {
  return {
    id: value.value,
    name: value.name,
    ...value.description === undefined || value.description === null ? {} : { description: value.description },
  }
}

/**
 * Model catalog backed by the agent's own session configuration.
 *
 * One refresh serves every concurrent caller; a failed refresh keeps serving
 * the last successful catalog rather than emptying a model selector that was
 * working a moment ago.
 */
export class DevinCatalog {
  private cache: CatalogCache | undefined
  private pending: Promise<readonly CatalogModel[]> | undefined
  private readonly contextWindows = new Map<string, number>()

  /**
   * @param spec - process facts used for the throwaway discovery session.
   * @param modelConfigId - session option id that selects the model when the agent publishes no `model` category.
   * @param ttlMs - how long a successful discovery stays authoritative.
   * @param timeoutMs - bound for one discovery, including agent startup.
   */
  constructor(
    private readonly spec: AcpAgentSpec,
    private readonly modelConfigId: string,
    private readonly ttlMs: number,
    private readonly timeoutMs: number,
  ) {}

  /**
   * List the models the agent currently offers.
   * @returns the cached catalog while it is fresh, otherwise a live refresh.
   * @throws DevinAcpFailure when no catalog has ever been read and discovery fails.
   */
  async list(): Promise<readonly CatalogModel[]> {
    const cached = this.cache
    if (cached !== undefined && Date.now() - cached.fetchedAt < this.ttlMs) return cached.models
    if (this.pending !== undefined) return this.pending
    this.pending = this.refresh()
    try {
      return await this.pending
    } finally {
      this.pending = undefined
    }
  }

  /**
   * Look one model up in the most recent catalog.
   * @param model - exact model id.
   * @returns the advertised entry, or `undefined` when the catalog has no such model.
   */
  find(model: string): CatalogModel | undefined {
    return this.cache?.models.find(candidate => candidate.id === model)
  }

  /**
   * Read the context capacity the agent last reported for one model.
   * @param model - exact model id.
   * @returns the capacity in tokens, or `undefined` before the agent reports one.
   */
  contextWindow(model: string): number | undefined {
    return this.contextWindows.get(model)
  }

  /**
   * Record the context capacity the agent reported for the model of a live session.
   * @param model - exact model id the session is using.
   * @param tokens - total context window size the agent published.
   */
  learnContextWindow(model: string, tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return
    this.contextWindows.set(model, tokens)
  }

  /** One discovery attempt, with stale-cache retention on failure. */
  private async refresh(): Promise<readonly CatalogModel[]> {
    try {
      const models = await this.probe()
      this.cache = { models, fetchedAt: Date.now() }
      return models
    } catch (error: unknown) {
      if (this.cache === undefined) throw error
      this.spec.warn('devin-acp: keeping the previous model catalog after a failed refresh', error)
      return this.cache.models
    }
  }

  /** Open one throwaway session and read its model option. */
  private async probe(): Promise<readonly CatalogModel[]> {
    const session = await openAcpSession(this.spec, AbortSignal.timeout(this.timeoutMs))
    try {
      return readModelOption(session.configOptions(), this.modelConfigId)
    } finally {
      await session.deleteSession()
      try {
        await session.dispose()
      } catch (error: unknown) {
        this.spec.warn('devin-acp: a discovery session process did not exit cleanly', error)
      }
    }
  }
}

/**
 * Read the model catalog out of a session's configuration options.
 *
 * The `model` category is the protocol-level signal; `modelConfigId` is the
 * configured fallback for agents that publish no category.
 * @param options - configuration options the agent published for a new session.
 * @param modelConfigId - session option id that selects the model.
 * @returns advertised models in agent order, deduplicated by value.
 * @throws DevinAcpFailure when the agent publishes no selectable model list.
 */
export function readModelOption(
  options: readonly SessionConfigOption[],
  modelConfigId: string,
): readonly CatalogModel[] {
  const option = options.find(candidate => candidate.category === 'model')
    ?? options.find(candidate => candidate.id === modelConfigId)
  if (option === undefined) {
    throw new DevinAcpFailure(
      'session',
      undefined,
      'Devin ACP agent published no model selection option; configure a model list or use an agent that advertises one',
    )
  }
  const models: CatalogModel[] = []
  const seen = new Set<string>()
  for (const value of selectValues(option)) {
    if (seen.has(value.value)) continue
    seen.add(value.value)
    models.push(catalogModel(value))
  }
  if (models.length === 0) {
    throw new DevinAcpFailure('session', undefined, 'Devin ACP agent published an empty model selection option')
  }
  return models
}
