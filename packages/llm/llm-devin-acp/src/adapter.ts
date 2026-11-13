/**
 * Harness LLM adapter backed by the Devin ACP agent.
 *
 * The adapter presents Devin's models as an ordinary harness provider, but the
 * Devin agent runs its own loop: it plans, edits files, and runs commands with
 * its own tools. The harness therefore forwards conversation text only, keeps
 * one long-lived Devin session per harness session, and reports the agent's
 * final answer as the assistant message of the step.
 *
 * @module @deepseek-ai/dsh-llm-devin-acp/adapter
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  LlmError,
  type FinishReason,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock as AcpContentBlock, SessionUpdate, StopReason } from '@agentclientprotocol/sdk'
import { DevinAcpFailure, openAcpSession, type AcpAgentSpec, type AcpSessionHandle } from './acp.ts'
import { DevinCatalog } from './catalog.ts'
import { renderPrompt, skipOwnAnswer, tailAfter, transcriptEntries, type TranscriptEntry } from './transcript.ts'

/** ACP `auth_required` code, returned when the agent needs a signed-in account. */
const ACP_AUTH_REQUIRED = -32000

/** Text emitted when the agent finishes a turn without any assistant output. */
const NO_ANSWER_TEXT = 'Devin finished the turn without a text answer.'

/**
 * How long a cancelled or failed turn waits for the agent to acknowledge the
 * cancel before its process is released. The window lets a cooperative agent
 * stop between edits; an uncooperative one is killed anyway.
 */
const CANCEL_ACKNOWLEDGE_MS = 1_000

/** Resolved provider configuration (schemastery has filled every default). */
export interface ResolvedDevinAcpConfig {
  /** Registered provider route. */
  readonly providerName: string
  /** Human-readable provider name for model selectors. */
  readonly displayName: string
  /** The Devin executable. */
  readonly command: string
  /** Arguments passed to {@link command}. */
  readonly args: readonly string[]
  /** Extra environment variables for the agent process. */
  readonly env: Record<string, string>
  /** Working directory for every agent process and session; defaults to the harness process directory. */
  readonly cwd?: string
  /** How the agent's own permission prompts are answered. */
  readonly permission: 'allow' | 'reject'
  /** Session option id that selects the model. */
  readonly modelConfigId: string
  /** How long a discovered model catalog stays authoritative. */
  readonly discoveryTtlMs: number
  /** Bound for one catalog discovery. */
  readonly discoveryTimeoutMs: number
  /** Idle agent sessions kept alive. */
  readonly maxSessions: number
  /** Idle time after which an agent session is released. */
  readonly sessionIdleMs: number
  /** Window after stdin EOF for an agent to flush and exit on its own. */
  readonly disposeEofGraceMs: number
  /** Termination grace used by the subprocess seam. */
  readonly disposeGraceMs: number
}

/** One live agent session serving a harness session. */
interface LiveSession {
  readonly handle: AcpSessionHandle
  /** Exact model this agent session runs. */
  model: string
  /** Keys of the entries already forwarded to it, in order. */
  cursor: readonly string[]
  /** Text this provider streamed for the previous turn, echoed back by the next projection. */
  lastAnswer?: string
  /** Tail of the prompt reservation queue: the next prompt waits for it. */
  tail: Promise<void>
  /** Prompts currently holding this session, queued or running. */
  active: number
  /** Last time a prompt started or finished. */
  lastUsed: number
}

/** A reserved agent session and the entries this prompt must send. */
interface Reservation {
  readonly key: string
  readonly live: LiveSession
  readonly outgoing: readonly TranscriptEntry[]
  readonly release: () => void
}

/** Ordered hand-off from ACP notification callbacks to the streaming generator. */
class UpdateQueue<T> {
  private readonly items: T[] = []
  private waiter: (() => void) | undefined
  private closed = false

  push(item: T): void {
    if (this.closed) return
    this.items.push(item)
    this.wake()
  }

  close(): void {
    this.closed = true
    this.wake()
  }

  private wake(): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }

  async *drain(): AsyncGenerator<T> {
    while (true) {
      const next = this.items.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => { this.waiter = resolve })
    }
  }
}

/** Text one ACP content block contributes (non-text blocks contribute none). */
function contentText(content: AcpContentBlock): string {
  return content.type === 'text' ? content.text : ''
}

/** Classify one session update as assistant text, reasoning, or nothing this provider surfaces. */
function streamText(update: SessionUpdate): { readonly type: 'text' | 'reasoning'; readonly text: string } | undefined {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = contentText(update.content)
      return text.length === 0 ? undefined : { type: 'text', text }
    }
    case 'agent_thought_chunk': {
      const text = contentText(update.content)
      return text.length === 0 ? undefined : { type: 'reasoning', text }
    }
    default:
      // Tool calls, plans, and mode changes belong to the agent's own loop.
      return undefined
  }
}

/** Read the context capacity a usage update reports, when the update carries one. */
function reportedContextWindow(update: SessionUpdate): number | undefined {
  return update.sessionUpdate === 'usage_update' ? update.size : undefined
}

/** Map one ACP terminal reason to the harness finish vocabulary. */
function finishFor(reason: StopReason): FinishReason {
  switch (reason) {
    case 'end_turn':
      return { kind: 'stop' }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'cancelled':
      return { kind: 'aborted', failure: { message: 'Devin cancelled the turn', code: 'ABORTED' } }
    case 'refusal':
      return { kind: 'error', failure: { message: 'Devin declined the request', code: 'REFUSAL' } }
    case 'max_turn_requests':
      return {
        kind: 'error',
        failure: { message: 'Devin reached its turn-request budget before answering', code: 'DEVIN_TURN_LIMIT' },
      }
    default:
      return {
        kind: 'error',
        failure: { message: `Devin stopped for an unrecognized reason: ${String(reason)}`, code: 'DEVIN_ACP_FAILURE' },
      }
  }
}

/**
 * Resolve when the caller cancels, so a queued prompt does not outlive it.
 * @param signal - caller cancellation, when the request carried one.
 * @returns a rejection on abort, or a promise that never settles without one.
 */
function abortRejection(signal: AbortSignal | undefined): Promise<never> {
  if (signal === undefined) return new Promise<never>(() => {})
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new LlmError('Devin turn was cancelled before it started', 'ABORTED'))
      return
    }
    signal.addEventListener('abort', () => {
      reject(new LlmError('Devin turn was cancelled before it started', 'ABORTED'))
    }, { once: true })
  })
}

/** Close one open content block. */
function endBlock(block: { readonly type: 'text' | 'reasoning'; readonly index: number; readonly text: string }): StreamChunk {
  return {
    type: 'block-end',
    index: block.index,
    block: block.type === 'text' ? { type: 'text', text: block.text } : { type: 'reasoning', text: block.text },
  }
}

/** Translate one rendered prompt into ACP content blocks. */
function toAcpPrompt(text: string): AcpContentBlock[] {
  return [{ type: 'text', text }]
}

/**
 * The registered provider: Devin models over the ACP agent.
 *
 * One agent session lives per harness session id, so the agent keeps the
 * context it built. A harness conversation that no longer extends the entries
 * already forwarded (a fork, a compaction rewrite, or a different route)
 * releases that session and replays the conversation into a fresh one.
 */
export class DevinAcpAdapter extends LlmAdapter {
  private readonly catalog: DevinCatalog
  private readonly live = new Map<string, LiveSession>()
  private closed = false

  /**
   * @param ctx - host context supplying the subprocess seam and logging.
   * @param config - resolved provider configuration.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedDevinAcpConfig,
  ) {
    super()
    this.catalog = new DevinCatalog(
      this.agentSpec,
      config.modelConfigId,
      config.discoveryTtlMs,
      config.discoveryTimeoutMs,
    )
  }

  /** Process facts for one spawn or discovery. */
  private get agentSpec(): AcpAgentSpec {
    return {
      command: this.config.command,
      args: this.config.args,
      env: this.config.env,
      cwd: this.config.cwd ?? process.cwd(),
      permission: this.config.permission,
      disposeEofGraceMs: this.config.disposeEofGraceMs,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spec => this.ctx.subprocess.spawn(spec),
      warn: (message, error) => {
        this.ctx.logger.warn(message)
        if (error !== undefined) this.ctx.logger.warn(error)
      },
    }
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.config.displayName }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    let models: Awaited<ReturnType<DevinCatalog['list']>>
    try {
      models = await this.catalog.list()
    } catch (error: unknown) {
      throw this.agentFailure(error, 'start')
    }
    return models.map(model => ({
      provider,
      id: model.id,
      name: model.name,
      ...model.description === undefined ? {} : { description: model.description },
      // Prompts are text: an image reaches the agent as the harness text handle,
      // never as image bytes, so the route must not claim image input.
      inputModalities: ['text'],
    }))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const advertised = this.catalog.find(model)
    const contextWindow = this.catalog.contextWindow(model)
    return Promise.resolve({
      provider,
      id: model,
      name: advertised?.name ?? model,
      ...advertised?.description === undefined ? {} : { description: advertised.description },
      inputModalities: ['text'],
      ...contextWindow === undefined ? {} : { context: { contextWindow } },
    })
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (this.closed) throw new LlmError('Devin ACP provider is disposed', 'NO_ADAPTER')
    options.signal?.throwIfAborted()
    this.releaseIdle()
    // `purpose` is declared by its consumer packages, so the base vocabulary
    // types it as never; the runtime value still separates auxiliary calls.
    const purpose = options.purpose as string | undefined
    const ephemeral = purpose !== undefined || options.sessionId === undefined
    const entries = transcriptEntries(options.messages, ephemeral)
    if (entries.length === 0) {
      throw new LlmError('Devin ACP request carries no text to send', 'INVALID_REQUEST')
    }
    if (ephemeral) {
      yield* this.oneShot(options, entries)
      return
    }
    yield* this.conversation(options, entries, String(options.sessionId))
  }

  /** Run one auxiliary request on a throwaway agent session. */
  private async *oneShot(options: GenerateOptions, entries: readonly TranscriptEntry[]): AsyncGenerator<StreamChunk> {
    const handle = await this.openAgent(options.model, options.signal)
    try {
      yield* this.answer(handle, entries, entries, options, options.model)
    } finally {
      await handle.deleteSession()
      try {
        await handle.dispose()
      } catch (error: unknown) {
        this.warn('devin-acp: an auxiliary agent process did not exit cleanly', error)
      }
    }
  }

  /** Run one turn on the harness session's long-lived agent session. */
  private async *conversation(
    options: GenerateOptions,
    entries: readonly TranscriptEntry[],
    key: string,
  ): AsyncGenerator<StreamChunk> {
    const reservation = await this.reserve(key, options.model, entries, options.signal)
    try {
      yield* this.answer(reservation.live.handle, reservation.outgoing, entries, options, options.model, reservation)
    } finally {
      reservation.release()
    }
  }

  /**
   * Reserve the harness session's agent session, creating or replaying it as needed.
   * @param key - harness session identity.
   * @param model - exact model the request selected.
   * @param entries - the complete current conversation projection.
   * @param signal - caller cancellation while the reservation queues.
   * @returns the reservation whose release ends the prompt.
   */
  private async reserve(
    key: string,
    model: string,
    entries: readonly TranscriptEntry[],
    signal: AbortSignal | undefined,
  ): Promise<Reservation> {
    const existing = this.live.get(key)
    if (existing !== undefined) {
      const release = await this.lock(existing, signal)
      const delta = tailAfter(entries, existing.cursor)
      if (delta !== undefined) {
        try {
          await this.applyModel(existing.handle, model)
        } catch (error: unknown) {
          release()
          this.releaseSession(key, existing)
          throw error
        }
        return { key, live: existing, outgoing: skipOwnAnswer(delta, existing.lastAnswer), release }
      }
      // The conversation no longer extends what this agent saw: replace it.
      release()
      this.releaseSession(key, existing)
    }
    this.releaseForCapacity()
    const handle = await this.openAgent(model, signal)
    const live: LiveSession = { handle, model, cursor: [], tail: Promise.resolve(), active: 0, lastUsed: Date.now() }
    this.live.set(key, live)
    const release = await this.lock(live, signal)
    return { key, live, outgoing: entries, release }
  }

  /**
   * Queue behind any prompt already running on a session.
   * @param live - the session to reserve.
   * @param signal - caller cancellation while queued.
   * @returns the release callback for this reservation.
   */
  private async lock(live: LiveSession, signal: AbortSignal | undefined): Promise<() => void> {
    const previous = live.tail
    const gate = Promise.withResolvers<void>()
    live.tail = previous.then(() => gate.promise)
    try {
      await Promise.race([previous, abortRejection(signal)])
    } catch (error: unknown) {
      // The caller gave up while queued: hand the turn to the next waiter
      // without claiming the session it never held.
      gate.resolve()
      throw error
    }
    live.active += 1
    live.lastUsed = Date.now()
    return () => {
      live.active -= 1
      live.lastUsed = Date.now()
      gate.resolve()
    }
  }

  /** Spawn one agent session and select the requested model on it. */
  private async openAgent(model: string, signal: AbortSignal | undefined): Promise<AcpSessionHandle> {
    let handle: AcpSessionHandle
    try {
      handle = await openAcpSession(this.agentSpec, signal)
    } catch (error: unknown) {
      throw this.agentFailure(error, 'start')
    }
    try {
      await this.applyModel(handle, model)
    } catch (error: unknown) {
      await handle.dispose().catch((disposeError: unknown) => {
        this.warn('devin-acp: a rejected agent session did not exit cleanly', disposeError)
      })
      throw error
    }
    return handle
  }

  /**
   * Select one model on a live agent session.
   *
   * An agent that publishes no model option keeps its own default: the adapter
   * then reports whatever model the harness selected without overriding it.
   * @param handle - the agent session to reconfigure.
   * @param model - exact model id from the request.
   */
  private async applyModel(handle: AcpSessionHandle, model: string): Promise<void> {
    const options = handle.configOptions()
    const option = options.find(candidate => candidate.category === 'model')
      ?? options.find(candidate => candidate.id === this.config.modelConfigId)
    if (option === undefined || option.type !== 'select' || option.currentValue === model) return
    try {
      await handle.setConfigOption(option.id, model)
    } catch (error: unknown) {
      throw LlmError.fromFailure({
        message: `Devin rejected model "${model}"; refresh the model list and select one this account offers`,
        code: 'DEVIN_MODEL_UNAVAILABLE',
      }, { cause: error })
    }
  }

  /**
   * Send one prompt and translate the agent's updates into stream chunks.
   * @param handle - the agent session that answers.
   * @param outgoing - entries this prompt actually sends.
   * @param complete - the whole conversation projection, recorded as the cursor on success.
   * @param options - the harness request supplying cancellation.
   * @param model - exact model id, used to record a reported context capacity.
   * @param reservation - the long-lived reservation whose cursor advances after a complete turn.
   */
  private async *answer(
    handle: AcpSessionHandle,
    outgoing: readonly TranscriptEntry[],
    complete: readonly TranscriptEntry[],
    options: GenerateOptions,
    model: string,
    reservation?: Reservation,
  ): AsyncGenerator<StreamChunk> {
    const signal = options.signal
    const queue = new UpdateQueue<SessionUpdate>()
    const prompt = handle.prompt(toAcpPrompt(renderPrompt(outgoing)), (update) => {
      const contextWindow = reportedContextWindow(update)
      if (contextWindow !== undefined) this.catalog.learnContextWindow(model, contextWindow)
      queue.push(update)
    })
    const settled = prompt.then(
      result => ({ kind: 'result' as const, result }),
      (error: unknown) => ({ kind: 'failure' as const, error }),
    )
    void settled.then(() => { queue.close() })

    const onAbort = (): void => {
      void handle.cancel().catch((error: unknown) => {
        this.warn('devin-acp: cancel notification failed', error)
      })
      queue.close()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    let block: { type: 'text' | 'reasoning'; index: number; text: string } | undefined
    let answerText = ''
    let nextIndex = 0
    let completed = false
    try {
      for await (const update of queue.drain()) {
        const delta = streamText(update)
        if (delta === undefined) continue
        if (block === undefined || block.type !== delta.type) {
          if (block !== undefined) yield endBlock(block)
          block = { type: delta.type, index: nextIndex, text: '' }
          nextIndex += 1
          yield { type: 'block-start', index: block.index, blockType: delta.type }
        }
        block.text += delta.text
        if (delta.type === 'text') answerText += delta.text
        yield delta.type === 'text'
          ? { type: 'text-delta', index: block.index, text: delta.text }
          : { type: 'reasoning-delta', index: block.index, text: delta.text }
      }
      if (block !== undefined) yield endBlock(block)

      if (signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Devin turn was cancelled', code: 'ABORTED' } } }
        return
      }

      const outcome = await settled
      if (outcome.kind === 'failure') {
        this.warn('devin-acp: the prompt failed', outcome.error)
        throw this.agentFailure(outcome.error, 'prompt')
      }
      if (block === undefined && outcome.result.stopReason === 'end_turn') {
        // A turn that ends with tool work and no closing message still owes the
        // harness one assistant block; state the outcome instead of failing.
        answerText = NO_ANSWER_TEXT
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: NO_ANSWER_TEXT }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: NO_ANSWER_TEXT } }
      }
      const finish = finishFor(outcome.result.stopReason)
      completed = finish.kind === 'stop' || finish.kind === 'max-tokens'
      if (completed && reservation !== undefined) {
        reservation.live.cursor = complete.map(entry => entry.key)
        reservation.live.lastAnswer = answerText
      }
      yield { type: 'finish', reason: finish }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (!completed) {
        // The turn did not finish cleanly, or the consumer abandoned the stream
        // mid-turn: stop the agent before releasing its process, so a
        // cooperative agent is never killed mid-edit.
        await handle.cancel().catch((error: unknown) => {
          this.warn('devin-acp: cancel notification failed', error)
        })
        const acknowledge = new Promise<void>((resolve) => {
          setTimeout(resolve, CANCEL_ACKNOWLEDGE_MS).unref()
        })
        await Promise.race([settled, acknowledge])
        this.abandonSession(handle, reservation)
      }
    }
  }

  /** Drop a session whose turn did not complete, releasing its process without waiting. */
  private abandonSession(handle: AcpSessionHandle, reservation: Reservation | undefined): void {
    if (reservation !== undefined && this.live.get(reservation.key) === reservation.live) {
      this.live.delete(reservation.key)
    }
    void handle.dispose().catch((error: unknown) => {
      this.warn('devin-acp: an agent process did not exit cleanly', error)
    })
  }

  /** Drop a session from the map and release its process. */
  private releaseSession(key: string, live: LiveSession): void {
    if (this.live.get(key) !== live) return
    this.live.delete(key)
    void live.handle.dispose().catch((error: unknown) => {
      this.warn('devin-acp: an agent process did not exit cleanly', error)
    })
  }

  /** Release sessions idle past the configured bound. */
  private releaseIdle(): void {
    const now = Date.now()
    for (const [key, live] of this.live) {
      if (live.active > 0 || now - live.lastUsed <= this.config.sessionIdleMs) continue
      this.releaseSession(key, live)
    }
  }

  /** Release the least recently used idle session while the map is at capacity. */
  private releaseForCapacity(): void {
    while (this.live.size >= this.config.maxSessions) {
      let oldest: [string, LiveSession] | undefined
      for (const entry of this.live) {
        if (entry[1].active > 0) continue
        if (oldest === undefined || entry[1].lastUsed < oldest[1].lastUsed) oldest = entry
      }
      if (oldest === undefined) return
      this.releaseSession(oldest[0], oldest[1])
    }
  }

  /** Release every agent session; the provider can serve no further requests afterwards. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const failures: Error[] = []
    for (const [key, live] of [...this.live]) {
      this.live.delete(key)
      try {
        await live.handle.dispose()
      } catch (error: unknown) {
        failures.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
    const [first] = failures
    if (first !== undefined && failures.length === 1) throw first
    if (failures.length > 1) throw new AggregateError(failures, 'Devin ACP provider teardown failed')
  }

  /** Report a non-fatal host observation. */
  private warn(message: string, error?: unknown): void {
    this.ctx.logger.warn(message)
    if (error !== undefined) this.ctx.logger.warn(error)
  }

  /** Map one ACP failure to a typed, non-retryable harness failure. */
  private agentFailure(error: unknown, operation: 'start' | 'prompt'): LlmError {
    if (error instanceof DevinAcpFailure && error.acpCode === ACP_AUTH_REQUIRED) {
      return new LlmError('Devin requires authentication; run `devin auth login` and retry', 'AUTH', { cause: error })
    }
    const stage = error instanceof DevinAcpFailure ? error.stage : 'unknown'
    return LlmError.fromFailure({
      message: `Devin ACP agent failed during ${operation} (stage: ${stage})`,
      code: 'DEVIN_ACP_FAILURE',
    }, { cause: error })
  }
}
