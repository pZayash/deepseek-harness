/**
 * Client transport for one Devin ACP agent process.
 *
 * The module owns exactly one spawned agent: it performs the ACP handshake,
 * creates the remote session that requests are sent on, and releases the whole
 * managed process range on disposal. Prompt streaming reaches callers through a
 * callback, so the LLM adapter can translate updates into harness chunks while
 * the prompt request is still in flight.
 *
 * @module @deepseek-ai/dsh-llm-devin-acp/acp
 */

import { Readable as NodeReadable, Writable as NodeWritable, type Readable, type Writable } from 'node:stream'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ContentBlock as AcpContentBlock,
  type PromptResponse,
  type SessionConfigOption,
  type SessionUpdate,
} from '@agentclientprotocol/sdk'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** How the client answers the agent's own `session/request_permission` prompts. */
export type PermissionPolicy = 'allow' | 'reject'

/** Which operation of the ACP exchange failed. */
export type AcpStage = 'spawn' | 'initialize' | 'session' | 'prompt' | 'dispose'

/** Fixed facts for one failed ACP operation; the original failure rides the `cause` chain. */
export class DevinAcpFailure extends Error {
  /**
   * @param stage - the ACP operation that failed.
   * @param acpCode - the JSON-RPC error code the agent returned, when it returned one.
   * @param message - a fixed description that never carries prompts, paths, or credentials.
   * @param cause - the original failure, retained for host diagnostics.
   */
  constructor(
    readonly stage: AcpStage,
    readonly acpCode: number | undefined,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause })
    this.name = 'DevinAcpFailure'
  }
}

/** Everything needed to spawn and drive one agent process. */
export interface AcpAgentSpec {
  /** The agent executable. */
  readonly command: string
  /** Arguments passed to {@link command}. */
  readonly args: readonly string[]
  /** Extra environment variables added to the scrubbed parent environment. */
  readonly env: Record<string, string>
  /** Working directory for the process and for the ACP session it opens. */
  readonly cwd: string
  /** How to answer the agent's permission prompts; no human is asked. */
  readonly permission: PermissionPolicy
  /** Window after stdin EOF for the agent to flush and exit on its own. */
  readonly disposeEofGraceMs: number
  /** Termination grace used by the subprocess seam when escalation is required. */
  readonly disposeGraceMs: number
  /** Spawn function from the subprocess seam. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Host sink for non-fatal observations, such as a probe session that outlived its run. */
  readonly warn: (message: string, error?: unknown) => void
}

/** One live ACP session over a spawned agent process. */
export interface AcpSessionHandle {
  /** Agent-assigned session id, unique only within this process. */
  readonly sessionId: string
  /** Whether the agent advertised `session/delete`, so a probe can remove its session. */
  readonly canDeleteSession: boolean
  /** Session configuration options as the agent last published them. */
  configOptions(): readonly SessionConfigOption[]
  /**
   * Change one session configuration option.
   * @param configId - the option id the agent advertised.
   * @param value - one advertised value id.
   * @returns the agent's complete option list after the change.
   */
  setConfigOption(configId: string, value: string): Promise<readonly SessionConfigOption[]>
  /**
   * Send one prompt and stream its session updates to `onUpdate`.
   * @param prompt - content blocks for this user turn.
   * @param onUpdate - receives every `session/update` notification until the prompt settles.
   * @returns the agent's terminal prompt response.
   */
  prompt(prompt: readonly AcpContentBlock[], onUpdate: (update: SessionUpdate) => void): Promise<PromptResponse>
  /** Ask the agent to cancel its active turn; the process stays alive. */
  cancel(): Promise<void>
  /** Delete the remote session so a probe leaves nothing behind. */
  deleteSession(): Promise<void>
  /** Terminate the managed process range; idempotent. */
  dispose(): Promise<void>
}

/** JSON-RPC error code preserved for diagnostics, when the failure carried one. */
function acpCodeOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'number' ? error.code : undefined
}

/** Wait for whole-range process exit, reporting a grace expiry instead of throwing. */
async function rangeExitsWithin(child: SubprocessHandle, graceMs: number): Promise<boolean> {
  try {
    return await child.waitForExit(AbortSignal.timeout(Math.max(1, Math.ceil(graceMs))))
  } catch {
    // The bounded wait aborts when the grace expires, proving the range is still alive.
    return false
  }
}

/** The protocol streams of a spawned agent, proven present by the guard in {@link spawnChild}. */
interface PipedStreams {
  readonly stdin: Writable
  readonly stdout: Readable
}

/** Spawn the agent with piped protocol streams, or report the failure as a spawn stage. */
function spawnChild(spec: AcpAgentSpec): { child: SubprocessHandle; streams: PipedStreams } {
  let child: SubprocessHandle
  try {
    child = spec.spawn({
      argv: [spec.command, ...spec.args],
      cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: spec.disposeGraceMs,
      env: spec.env,
    })
  } catch (error: unknown) {
    throw new DevinAcpFailure('spawn', undefined, 'Devin ACP agent process could not be started', error)
  }
  /* v8 ignore start -- a piped disposition always exposes both streams; defensive against a broken seam. */
  if (child.stdin === undefined || child.stdout === undefined) {
    throw new DevinAcpFailure('spawn', undefined, 'Devin ACP agent process started without its protocol streams')
  }
  /* v8 ignore stop */
  return { child, streams: { stdin: child.stdin, stdout: child.stdout } }
}

/** Reject when startup is cancelled; a caller without cancellation parks forever. */
function abortRejection(signal: AbortSignal | undefined): Promise<never> {
  if (signal === undefined) return new Promise<never>(() => {})
  return new Promise<never>((_resolve, reject) => {
    const abort = (): void => {
      reject(new DevinAcpFailure('initialize', undefined, 'Devin ACP agent start was cancelled'))
    }
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Spawn one agent and open its ACP session.
 *
 * Startup failures release the process before rejecting, so a caller never
 * receives a handle it cannot dispose.
 * @param spec - the process and permission facts for this agent.
 * @param signal - cancellation for startup only; an aborted start releases the process.
 * @returns the ready session handle.
 */
export async function openAcpSession(spec: AcpAgentSpec, signal?: AbortSignal): Promise<AcpSessionHandle> {
  const { child, streams } = spawnChild(spec)
  let released = false
  let disposal: Promise<void> | undefined

  const disposeProcess = (): Promise<void> => (disposal ??= (async () => {
    streams.stdin.end()
    if (await rangeExitsWithin(child, spec.disposeEofGraceMs)) return
    // terminate() owns the bounded SIGTERM→SIGKILL ladder; this wait is the exit proof.
    child.terminate()
    await child.waitForExit()
  })())

  // A rejected process outcome races every startup step: a child that dies
  // before publishing its session never leaves the caller waiting.
  const processRejected: Promise<never> = child.done.then(
    /* v8 ignore next -- the success arm parks forever; the connection observes a clean close. */
    () => new Promise<never>(() => {}),
    (error: unknown) => Promise.reject(error instanceof Error ? error : new Error(String(error))),
  )
  processRejected.catch(() => { /* observed by the startup race */ })

  let activeUpdate: ((update: SessionUpdate) => void) | undefined
  const app = createAcpClientApp({ name: 'deepseek-harness-llm-devin-acp' })
    .onNotification(methods.client.session.update, ({ params }) => {
      activeUpdate?.(params.update)
      return Promise.resolve()
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      if (spec.permission === 'allow') {
        const allow = params.options.find(option => option.kind === 'allow_once' || option.kind === 'allow_always')
        if (allow !== undefined) {
          return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } })
        }
      }
      // Without an allow option, or under the reject policy, the agent must not proceed.
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    })

  const { agent } = app.connect(ndJsonStream(
    NodeWritable.toWeb(streams.stdin) as WritableStream<Uint8Array>,
    NodeReadable.toWeb(streams.stdout) as ReadableStream<Uint8Array>,
  ))

  let sessionId: string | undefined
  let options: readonly SessionConfigOption[] = []
  let canDeleteSession = false
  let startupStage: AcpStage = 'initialize'

  const requireSession = (): string => {
    /* v8 ignore next -- every post-startup operation runs behind the startup await. */
    if (sessionId === undefined) throw new DevinAcpFailure('session', undefined, 'Devin ACP session is not open')
    return sessionId
  }

  try {
    await Promise.race([
      (async (): Promise<void> => {
        const initialized = await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          // Advertise no optional client capabilities: the agent self-serves its
          // own filesystem and terminal, exactly as it does for a human client.
          clientCapabilities: {},
        })
        canDeleteSession = initialized.agentCapabilities?.sessionCapabilities?.delete !== undefined
        startupStage = 'session'
        const created = await agent.request(methods.agent.session.new, { cwd: spec.cwd, mcpServers: [] })
        sessionId = created.sessionId
        options = created.configOptions ?? []
      })(),
      processRejected,
      abortRejection(signal),
    ])
  } catch (error: unknown) {
    try {
      await disposeProcess()
    } catch (disposeError: unknown) {
      // Cleanup failure is reported, but the startup failure stays authoritative.
      spec.warn('devin-acp: released a failed agent process that did not exit cleanly', disposeError)
    }
    throw error instanceof DevinAcpFailure
      ? error
      : new DevinAcpFailure(startupStage, acpCodeOf(error), `Devin ACP agent failed during ${startupStage}`, error)
  }

  return {
    get sessionId() {
      return requireSession()
    },
    get canDeleteSession() {
      return canDeleteSession
    },
    configOptions: () => options,
    async setConfigOption(configId, value) {
      try {
        const response = await agent.request(methods.agent.session.setConfigOption, {
          sessionId: requireSession(),
          configId,
          value,
        })
        options = response.configOptions
        return options
      } catch (error: unknown) {
        throw new DevinAcpFailure('session', acpCodeOf(error), 'Devin ACP rejected a session configuration change', error)
      }
    },
    async prompt(prompt, onUpdate) {
      activeUpdate = onUpdate
      try {
        return await agent.request(methods.agent.session.prompt, {
          sessionId: requireSession(),
          prompt: [...prompt],
        })
      } catch (error: unknown) {
        throw new DevinAcpFailure('prompt', acpCodeOf(error), 'Devin ACP agent failed while answering', error)
      } finally {
        activeUpdate = undefined
      }
    },
    async cancel() {
      await agent.notify(methods.agent.session.cancel, { sessionId: requireSession() })
    },
    async deleteSession() {
      if (sessionId === undefined || !canDeleteSession) return
      try {
        await agent.request(methods.agent.session.delete, { sessionId })
      } catch (error: unknown) {
        spec.warn('devin-acp: a probe session could not be deleted', error)
      }
    },
    async dispose() {
      if (released) return
      released = true
      try {
        await disposeProcess()
      } catch (error: unknown) {
        throw new DevinAcpFailure('dispose', undefined, 'Devin ACP agent process did not exit cleanly', error)
      }
    },
  }
}
