/**
 * Keyless integration tests for the Devin ACP LLM provider. Each spawns a real
 * subprocess — the scripted mock ACP agent — and drives it over real ACP
 * JSON-RPC through the real `llm` service, so discovery, session reuse,
 * transcript forwarding, model selection, cancellation, and teardown are all
 * exercised end to end.
 */

import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as plugin from '../src/index.ts'

const mockAgent = fileURLToPath(new URL('./mock-acp-agent.ts', import.meta.url))

/** Models the mock agent publishes; one carries a description, one is image-capable. */
const MODELS = [
  { value: 'mock-small', name: 'Mock Small', description: 'fast tier', supportsImages: false },
  { value: 'mock-large', name: 'Mock Large', supportsImages: true },
]

const cleanups: (() => unknown)[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** Read a JSONL log, tolerating a log the agent never wrote. */
function jsonLines(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

/** Collect one whole streamed response. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** Trailing terminal reason of one collected response. */
function finishOf(chunks: readonly StreamChunk[]): unknown {
  return chunks.at(-1)?.type === 'finish' ? chunks.at(-1) : undefined
}

/** One user message with plain text. */
function user(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** One assistant message produced by this provider in an earlier turn. */
function assistant(text: string) {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'devin', model: 'mock-small' },
  })
}

/**
 * Mount the provider against the mock agent.
 * @param env - extra mock-agent scripting variables.
 * @returns the context, its recorded prompt/lifecycle logs, and a request builder.
 */
async function setup(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-devin-acp-'))
  const promptLog = join(dir, 'prompts.jsonl')
  const lifecycleLog = join(dir, 'lifecycle.jsonl')
  const ctx = new Context()
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(plugin, {
    providerName: 'devin',
    displayName: 'Devin',
    command: process.execPath,
    args: [mockAgent],
    env: {
      MOCK_MODELS: JSON.stringify(MODELS),
      MOCK_TEXT: 'devin answer',
      MOCK_PROMPT_LOG: promptLog,
      MOCK_LIFECYCLE_LOG: lifecycleLog,
      ...env,
    },
    cwd: dir,
    permission: 'allow',
    modelConfigId: 'model',
    discoveryTtlMs: 600_000,
    discoveryTimeoutMs: 20_000,
    maxSessions: 2,
    sessionIdleMs: 600_000,
    disposeEofGraceMs: 2_000,
    disposeGraceMs: 1_000,
  })
  return {
    ctx,
    prompts: () => jsonLines(promptLog).map(entry => entry.text),
    lifecycle: () => jsonLines(lifecycleLog).map(entry => entry.event),
    request: (messages: GenerateOptions['messages'], extra: Partial<GenerateOptions> = {}): GenerateOptions => ({
      provider: 'devin',
      model: 'mock-small',
      sessionId: SessionId('session-1'),
      messages,
      ...extra,
    }),
  }
}

describe('devin acp provider', () => {
  it('lists the models the agent advertises and removes its probe session', async () => {
    const harness = await setup()

    expect(harness.ctx.llm.listProviders()).toContainEqual({ id: 'devin', name: 'Devin' })
    const models = await harness.ctx.llm.listModels('devin')

    expect(models).toEqual([
      { provider: 'devin', id: 'mock-small', name: 'Mock Small', description: 'fast tier', inputModalities: ['text'] },
      { provider: 'devin', id: 'mock-large', name: 'Mock Large', inputModalities: ['text'] },
    ])
    const created = harness.lifecycle().filter(event => event === 'new-session')
    const deleted = harness.lifecycle().filter(event => typeof event === 'string' && event.startsWith('delete-session:'))
    expect(created).toHaveLength(1)
    expect(deleted).toHaveLength(1)
  }, 30_000)

  it('streams reasoning and text, and forwards only the newest message', async () => {
    const harness = await setup({ MOCK_THOUGHT: '1' })

    const question = user('first question')
    const answer = assistant('devin answer')
    const followUp = user('second question')
    const first = await collect(harness.ctx.llm.stream(harness.request([
      createSystemMessage('HARNESS SYSTEM PROMPT'),
      question,
    ])))

    expect(first.map(chunk => chunk.type)).toEqual([
      'block-start', 'reasoning-delta', 'block-end', 'block-start', 'text-delta', 'block-end', 'finish',
    ])
    expect(finishOf(first)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(harness.prompts()).toEqual(['first question'])

    const second = await collect(harness.ctx.llm.stream(harness.request([
      createSystemMessage('HARNESS SYSTEM PROMPT'),
      question,
      answer,
      followUp,
    ])))

    expect(finishOf(second)).toMatchObject({ reason: { kind: 'stop' } })
    // The system prompt and the agent's own previous answer stay out of the
    // prompt, and the reused session is not recreated.
    expect(harness.prompts()).toEqual(['first question', 'second question'])
    expect(harness.lifecycle().filter(event => event === 'new-session')).toHaveLength(1)
  }, 60_000)

  it('replays the conversation into a fresh session when it diverges', async () => {
    const harness = await setup()
    await collect(harness.ctx.llm.stream(harness.request([user('original question')])))
    await collect(harness.ctx.llm.stream(harness.request([
      user('different opening'),
      assistant('devin answer'),
      user('follow-up'),
    ])))

    expect(harness.lifecycle().filter(event => event === 'new-session')).toHaveLength(2)
    // A fresh agent session has no memory of the conversation, so the replay
    // carries the earlier exchange as text.
    expect(harness.prompts().at(-1)).toBe('User: different opening\n\nAssistant: devin answer\n\nUser: follow-up')
  }, 60_000)

  it('selects the requested model on the reused session', async () => {
    const harness = await setup()
    const question = user('first question')
    await collect(harness.ctx.llm.stream(harness.request([question])))
    await collect(harness.ctx.llm.stream(harness.request(
      [question, assistant('devin answer'), user('second question')],
      { model: 'mock-large' },
    )))

    expect(harness.lifecycle()).toContain('set-model:mock-large')
    expect(harness.lifecycle().filter(event => event === 'new-session')).toHaveLength(1)
  }, 60_000)

  it('fails a model the agent does not offer, before prompting', async () => {
    const harness = await setup()
    const chunks = await collect(harness.ctx.llm.stream(harness.request([user('question')], { model: 'unknown-model' })))

    expect(finishOf(chunks)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'DEVIN_MODEL_UNAVAILABLE' } },
    })
    expect(harness.prompts()).toEqual([])
  }, 30_000)

  it('reports an unauthenticated account as an auth failure', async () => {
    const harness = await setup({ MOCK_AUTH_REQUIRED: '1' })

    const failure = await harness.ctx.llm.listModels('devin')
      .then((): undefined => undefined, (error: unknown): unknown => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ code: 'AUTH' })
    expect((failure as Error).message).toContain('devin auth login')
  }, 30_000)

  it('cancels a hung turn and settles aborted', async () => {
    const harness = await setup({ MOCK_HANG: '1' })
    const controller = new AbortController()
    const chunks: StreamChunk[] = []

    for await (const chunk of harness.ctx.llm.stream(harness.request(
      [user('long question')],
      { signal: controller.signal },
    ))) {
      chunks.push(chunk)
      if (chunk.type === 'text-delta') controller.abort()
    }

    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toHaveLength(1)
    expect(finishOf(chunks)).toMatchObject({ reason: { kind: 'aborted', failure: { code: 'ABORTED' } } })
    expect(harness.lifecycle()).toContain('cancel')
  }, 60_000)

  it('runs an auxiliary request on a throwaway session', async () => {
    const harness = await setup()

    const chunks = await collect(harness.ctx.llm.stream({
      provider: 'devin',
      model: 'mock-small',
      purpose: 'session-title',
      messages: [
        createSystemMessage('Produce a title.'),
        user('fix the flaky test'),
      ],
    }))

    expect(finishOf(chunks)).toMatchObject({ reason: { kind: 'stop' } })
    expect(harness.prompts()).toEqual(['System instructions: Produce a title.\n\nUser: fix the flaky test'])
    expect(harness.lifecycle().filter(event => event === 'new-session')).toHaveLength(1)
    expect(harness.lifecycle().filter(event => typeof event === 'string' && event.startsWith('delete-session:'))).toHaveLength(1)
  }, 60_000)

  it('learns the context window the agent reports', async () => {
    const harness = await setup({ MOCK_USAGE_SIZE: '128000' })
    await collect(harness.ctx.llm.stream(harness.request([user('question')])))

    const model = await harness.ctx.llm.resolveModelInfo('devin', 'mock-small')
    expect(model.context).toEqual({ contextWindow: 128_000 })
  }, 60_000)
})
