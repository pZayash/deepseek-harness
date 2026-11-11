/**
 * A scripted mock ACP AGENT for the keyless `dsh-llm-devin-acp` tests.
 *
 * It speaks the agent side of ACP over stdio and is fully scripted by
 * environment variables — no model, no network:
 *
 * - `MOCK_MODELS`       — JSON array of `{ value, name, description?, supportsImages? }`
 *                         published as the `model` session option.
 * - `MOCK_CURRENT_MODEL`— the initially selected model value (default: first entry).
 * - `MOCK_PROMPT_LOG`   — JSONL file receiving `{ text }` for every prompt.
 * - `MOCK_LIFECYCLE_LOG`— JSONL file receiving `{ event }` records
 *                         (`new-session`, `delete-session`, `set-model:<value>`).
 * - `MOCK_TEXT`         — assistant text streamed for one prompt (default `mock answer`).
 * - `MOCK_THOUGHT`      — `1` streams a reasoning chunk before the assistant text.
 * - `MOCK_USAGE_SIZE`   — when set, streams a `usage_update` with that context size.
 * - `MOCK_STOP`         — ACP `StopReason` returned from `prompt` (default `end_turn`).
 * - `MOCK_HANG`         — `1` keeps the prompt pending until `session/cancel`.
 * - `MOCK_AUTH_REQUIRED`— `1` answers `session/new` with the ACP `auth_required` error.
 *
 * It is a fixture, not a spec: specs launch it as a real subprocess over real
 * ACP JSON-RPC.
 *
 * @module @deepseek-ai/dsh-llm-devin-acp/tests/mock-acp-agent
 */

import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import {
  agent as createAcpAgentApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentContext,
  type CancelNotification,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SetSessionConfigOptionRequest,
  type StopReason,
} from '@agentclientprotocol/sdk'

interface MockModel {
  readonly value: string
  readonly name: string
  readonly description?: string
  readonly supportsImages?: boolean
}

const models: MockModel[] = JSON.parse(process.env.MOCK_MODELS ?? '[]') as MockModel[]
const TEXT = process.env.MOCK_TEXT ?? 'mock answer'
const THOUGHT = process.env.MOCK_THOUGHT === '1'
const USAGE_SIZE = process.env.MOCK_USAGE_SIZE
const STOP = (process.env.MOCK_STOP ?? 'end_turn') as StopReason
const HANG = process.env.MOCK_HANG === '1'
const AUTH_REQUIRED = process.env.MOCK_AUTH_REQUIRED === '1'
const PROMPT_LOG = process.env.MOCK_PROMPT_LOG
const LIFECYCLE_LOG = process.env.MOCK_LIFECYCLE_LOG

/** One model selection value, with the vendor image-capability metadata Devin publishes. */
function modelOption(current: string): SessionConfigOption {
  return {
    id: 'model',
    name: 'Model',
    description: 'AI model to use',
    category: 'model',
    type: 'select',
    currentValue: current,
    options: models.map(model => ({
      value: model.value,
      name: model.name,
      ...model.description === undefined ? {} : { description: model.description },
      ...model.supportsImages === undefined
        ? {}
        : { _meta: { 'cognition.ai/supportsImages': model.supportsImages } },
    })),
  }
}

/** The effort selector a real agent also publishes; the adapter must ignore it. */
function effortOption(): SessionConfigOption {
  return {
    id: 'thought_level',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  }
}

/** Append one lifecycle record so a spec can prove what the adapter did. */
function logLifecycle(event: string): void {
  if (LIFECYCLE_LOG === undefined) return
  appendFileSync(LIFECYCLE_LOG, `${JSON.stringify({ event })}\n`)
}

let currentModel = process.env.MOCK_CURRENT_MODEL ?? models[0]?.value ?? 'mock-small'
let resolveCancel: ((reason: StopReason) => void) | undefined

/** Agents hand out a fresh id and their default configuration. */
function newSession(_params: NewSessionRequest): NewSessionResponse {
  if (AUTH_REQUIRED) throw RequestError.authRequired()
  logLifecycle('new-session')
  return {
    sessionId: randomUUID(),
    configOptions: [modelOption(currentModel), effortOption()],
  }
}

/** Accept only published values, exactly like the real agent. */
function setConfigOption(params: SetSessionConfigOptionRequest) {
  if (params.configId !== 'model' || typeof params.value !== 'string' || !models.some(model => model.value === params.value)) {
    throw new Error(`Invalid value for config option ${params.configId}`)
  }
  currentModel = params.value
  logLifecycle(`set-model:${params.value}`)
  return { configOptions: [modelOption(currentModel), effortOption()] }
}

/** Stream the scripted answer, optionally waiting for cancellation. */
async function prompt(params: PromptRequest, conn: AgentContext): Promise<PromptResponse> {
  if (PROMPT_LOG !== undefined) {
    const text = params.prompt.map(block => block.type === 'text' ? block.text : '').join('\n')
    appendFileSync(PROMPT_LOG, `${JSON.stringify({ text })}\n`)
  }
  if (THOUGHT) {
    await conn.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'mock thinking' } },
    })
  }
  if (USAGE_SIZE !== undefined) {
    await conn.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'usage_update', used: 1, size: Number(USAGE_SIZE) },
    })
  }
  await conn.notify(methods.client.session.update, {
    sessionId: params.sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: TEXT } },
  })
  if (HANG) {
    return new Promise<PromptResponse>((resolve) => {
      resolveCancel = (reason) => { resolve({ stopReason: reason }) }
    })
  }
  return { stopReason: STOP }
}

/** Answer a cancellation for a hung prompt. */
function cancel(_params: CancelNotification): Promise<void> {
  logLifecycle('cancel')
  resolveCancel?.('cancelled')
  return Promise.resolve()
}

createAcpAgentApp({ name: 'dsh-llm-devin-acp-test-agent' })
  .onRequest(methods.agent.initialize, (): InitializeResponse => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      promptCapabilities: { image: true, audio: false, embeddedContext: false },
      sessionCapabilities: { delete: {} },
    },
    authMethods: [],
  }))
  .onRequest(methods.agent.session.new, ({ params }) => newSession(params))
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => setConfigOption(params))
  .onRequest(methods.agent.session.prompt, ({ params, client }) => prompt(params, client))
  .onNotification(methods.agent.session.cancel, ({ params }) => cancel(params))
  .onRequest(methods.agent.session.delete, ({ params }) => {
    logLifecycle(`delete-session:${params.sessionId}`)
    return {}
  })
  .connect(ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ))
