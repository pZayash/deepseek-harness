#!/usr/bin/env node
/**
 * ACP acceptance driver for the current branch.
 *
 * Spawns the shipped `acp` profile from source, drives it through the public ACP
 * SDK, and writes `report.md` + `report.json` beside this file. It verifies the
 * branch additions (session listing titles and session/fork) plus the baseline
 * lifecycle. A real model turn is required for the title and fork-history cases;
 * set `ACP_ACCEPTANCE_SMOKE=1` to run only the transport/fork-error paths without
 * model calls.
 *
 * Usage (from the repository root):
 *   node packages/acp/acp/acceptance/driver.mjs
 *   ACP_ACCEPTANCE_SMOKE=1 node packages/acp/acp/acceptance/driver.mjs
 *
 * Environment:
 *   DEEPSEEK_API_KEY           required in full mode; inherited by the server
 *   ACP_ACCEPTANCE_SMOKE=1     skip model-dependent cases
 *   ACP_ACCEPTANCE_KEEP=1      keep the temporary DSH_HOME and workspace
 *   ACP_ACCEPTANCE_TIMEOUT_MS  whole-run timeout (default 600000)
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  client as createClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'

const outputDir = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const SMOKE = process.env.ACP_ACCEPTANCE_SMOKE === '1'
const KEEP = process.env.ACP_ACCEPTANCE_KEEP === '1'
const RUN_TIMEOUT_MS = Number(process.env.ACP_ACCEPTANCE_TIMEOUT_MS ?? 600_000)
const CODEWORD = 'BANANA-42'

const results = []
const updates = []
let serverVersion
let serverStderr = ''
let connection
let child
let childExited

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function describeError(error) {
  const code = typeof error?.code === 'number' ? `[${error.code}] ` : ''
  const details = error?.data !== undefined && typeof error.data === 'object' && error.data !== null
    ? ` (details: ${String(error.data.details)})`
    : ''
  return `${code}${error?.message ?? String(error)}${details}`
}

async function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function step(id, title, fn) {
  const started = Date.now()
  try {
    const detail = await fn()
    results.push({
      id,
      title,
      status: 'pass',
      ms: Date.now() - started,
      ...(detail === undefined ? {} : { detail }),
    })
  } catch (error) {
    results.push({ id, title, status: 'fail', ms: Date.now() - started, error: describeError(error) })
  }
}

function skip(id, title, reason) {
  results.push({ id, title, status: 'skip', reason })
}

function textOfChunk(content) {
  const blocks = Array.isArray(content) ? content : [content]
  return blocks
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text')
    .map(block => block.text)
    .join('')
}

async function main() {
  const home = await mkdtemp(join(tmpdir(), 'acp-acceptance-home-'))
  const workspace = await mkdtemp(join(tmpdir(), 'acp-acceptance-ws-'))
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_AGENTS_HOME: join(home, '.agents'),
    NO_COLOR: '1',
  }
  if (SMOKE && env.DEEPSEEK_API_KEY === undefined) env.DEEPSEEK_API_KEY = 'sk-acceptance-smoke'

  child = spawn(
    process.execPath,
    ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'acp'],
    { cwd: repoRoot, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  )
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { serverStderr = (serverStderr + chunk).slice(-40_000) })
  child.on('error', (error) => { serverStderr += `\nspawn error: ${error.message}` })
  childExited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))

  const clientApp = createClientApp({ name: 'dsh-acp-acceptance' })
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update)
      return Promise.resolve()
    })
    .onRequest(methods.client.session.requestPermission, () => Promise.resolve({
      outcome: { outcome: 'cancelled' },
    }))
  connection = clientApp.connect(ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  ))
  const agent = connection.agent
  const rpc = (method, params) => agent.request(method, params)

  const openSessions = new Set()
  async function closeQuietly(sessionId) {
    openSessions.delete(sessionId)
    await withTimeout(
      rpc(methods.agent.session.close, { sessionId }),
      30_000,
      'session/close',
    ).catch(() => {})
  }

  let sessionA
  let initialized = false

  await step('T1', 'initialize advertises list/resume/fork/delete/close', async () => {
    const response = await withTimeout(
      rpc(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
      60_000,
      'initialize',
    )
    serverVersion = response.agentInfo?.version
    const capabilities = response.agentCapabilities ?? {}
    const sessions = capabilities.sessionCapabilities ?? {}
    assert(sessions.fork !== undefined && sessions.fork !== null, 'sessionCapabilities.fork is not advertised')
    assert(sessions.list !== undefined && sessions.list !== null, 'sessionCapabilities.list is not advertised')
    assert(sessions.resume !== undefined && sessions.resume !== null, 'sessionCapabilities.resume is not advertised')
    assert(sessions.close !== undefined && sessions.close !== null, 'sessionCapabilities.close is not advertised')
    assert(capabilities.loadSession === true, 'loadSession is not advertised')
    initialized = true
    return {
      server: response.agentInfo,
      promptCapabilities: capabilities.promptCapabilities,
      sessionCapabilities: Object.keys(sessions),
    }
  })
  if (!initialized) {
    skip('T2', 'new session and prompt', 'initialize failed')
  } else if (SMOKE) {
    skip('T2', 'new session and prompt', 'smoke mode skips model turns')
  } else {
    await step('T2', 'new session completes a real model turn', async () => {
      const created = await withTimeout(
        rpc(methods.agent.session.new, { cwd: workspace, mcpServers: [] }),
        60_000,
        'session/new',
      )
      sessionA = created.sessionId
      openSessions.add(sessionA)
      const start = updates.length
      const response = await withTimeout(
        rpc(methods.agent.session.prompt, {
          sessionId: sessionA,
          prompt: [{
            type: 'text',
            text: `Remember this codeword for later: ${CODEWORD}. Reply with exactly OK.`,
          }],
        }),
        180_000,
        'session/prompt',
      )
      const text = updates.slice(start)
        .filter(update => update.sessionUpdate === 'agent_message_chunk')
        .map(update => textOfChunk(update.content))
        .join('')
      assert(response.stopReason === 'end_turn', `unexpected stopReason: ${response.stopReason}`)
      assert(text.trim().length > 0, 'no assistant text was delivered')
      return { sessionId: sessionA, stopReason: response.stopReason, answerPrefix: text.trim().slice(0, 80) }
    })
  }

  if (SMOKE) {
    skip('T3', 'fork a live session', 'smoke mode skips model turns')
    skip('T4', 'fork inherits the conversation', 'smoke mode skips model turns')
    skip('T5', 'close the source session', 'smoke mode skips model turns')
    skip('T6', 'session/list returns a cached title', 'smoke mode skips model turns')
    skip('T7', 'fork a closed session', 'smoke mode skips model turns')
    skip('T8', 'resume a closed session', 'smoke mode skips model turns')
    skip('T9', 'fork rejects a mismatched cwd', 'smoke mode skips model turns')
    skip('T12', 'delete a closed session', 'smoke mode skips model turns')
    skip('T14', 'load replays the committed conversation', 'smoke mode skips model turns')
  } else {
    await step('T3', 'fork a live session', async () => {
      assert(sessionA !== undefined, 'prerequisite: no source session')
      const forked = await withTimeout(
        rpc(methods.agent.session.fork, { sessionId: sessionA, cwd: workspace, mcpServers: [] }),
        60_000,
        'session/fork (live)',
      )
      assert(forked.sessionId !== sessionA, 'fork returned the source session id')
      assert(Array.isArray(forked.configOptions) && forked.configOptions.length > 0, 'fork returned no config options')
      openSessions.add(forked.sessionId)
      await closeQuietly(forked.sessionId)
      return { sessionId: forked.sessionId }
    })

    await step('T4', 'fork inherits the completed conversation', async () => {
      assert(sessionA !== undefined, 'prerequisite: no source session')
      const forked = await withTimeout(
        rpc(methods.agent.session.fork, { sessionId: sessionA, cwd: workspace, mcpServers: [] }),
        60_000,
        'session/fork (history)',
      )
      openSessions.add(forked.sessionId)
      try {
        const start = updates.length
        const response = await withTimeout(
          rpc(methods.agent.session.prompt, {
            sessionId: forked.sessionId,
            prompt: [{ type: 'text', text: 'What codeword did I ask you to remember? Reply with the codeword only.' }],
          }),
          180_000,
          'session/prompt (fork)',
        )
        const text = updates.slice(start)
          .filter(update => update.sessionUpdate === 'agent_message_chunk')
          .map(update => textOfChunk(update.content))
          .join('')
        assert(response.stopReason === 'end_turn', `unexpected stopReason: ${response.stopReason}`)
        assert(text.includes(CODEWORD), `fork did not inherit the history; answer=${JSON.stringify(text.slice(0, 200))}`)
        return { answer: text.trim().slice(0, 120) }
      } finally {
        await closeQuietly(forked.sessionId)
      }
    })

    await step('T5', 'close the source session', async () => {
      assert(sessionA !== undefined, 'prerequisite: no source session')
      await withTimeout(
        rpc(methods.agent.session.close, { sessionId: sessionA }),
        30_000,
        'session/close (source)',
      )
      openSessions.delete(sessionA)
      return { sessionId: sessionA }
    })

    await step('T6', 'session/list returns a cached title', async () => {
      assert(sessionA !== undefined, 'prerequisite: no source session')
      const deadline = Date.now() + 15_000
      let entry
      while (Date.now() < deadline) {
        const listed = await withTimeout(
          rpc(methods.agent.session.list, {}),
          30_000,
          'session/list',
        )
        entry = (listed.sessions ?? []).find(item => item.sessionId === sessionA)
        if (entry !== undefined && typeof entry.title === 'string' && entry.title.length > 0) break
        await delay(300)
      }
      assert(entry !== undefined, 'closed session is missing from session/list')
      assert(typeof entry.title === 'string' && entry.title.length > 0, `session/list returned no title: ${JSON.stringify(entry)}`)
      return { title: entry.title }
    })

    await step('T7', 'fork a closed session', async () => {
      assert(sessionA !== undefined, 'prerequisite: no source session')
      const forked = await withTimeout(
        rpc(methods.agent.session.fork, { sessionId: sessionA, cwd: workspace, mcpServers: [] }),
        60_000,
        'session/fork (closed)',
      )
      assert(forked.sessionId !== sessionA, 'fork returned the source session id')
      openSessions.add(forked.sessionId)
      await closeQuietly(forked.sessionId)
      return { sessionId: forked.sessionId }
    })

    await step('T8', 'resume a closed session', async () => {
      assert(sessionA !== undefined, 'prerequisite: no source session')
      const resumed = await withTimeout(
        rpc(methods.agent.session.resume, { sessionId: sessionA, cwd: workspace, mcpServers: [] }),
        60_000,
        'session/resume',
      )
      assert(Array.isArray(resumed.configOptions) && resumed.configOptions.length > 0, 'resume returned no config options')
      openSessions.add(sessionA)
      await closeQuietly(sessionA)
      return { configOptionCount: resumed.configOptions.length }
    })

    await step('T9', 'fork rejects a mismatched cwd', async () => {
      assert(sessionA !== undefined, 'prerequisite: no source session')
      try {
        await withTimeout(
          rpc(methods.agent.session.fork, { sessionId: sessionA, cwd: tmpdir(), mcpServers: [] }),
          30_000,
          'session/fork (wrong cwd)',
        )
      } catch (error) {
        const text = describeError(error)
        assert(/cwd does not match/.test(text), `unexpected error: ${text}`)
        return { error: text }
      }
      throw new Error('fork with a mismatched cwd unexpectedly succeeded')
    })

    await step('T14', 'load replays the committed conversation', async () => {
      assert(sessionA !== undefined, 'prerequisite: no source session')
      const start = updates.length
      const loaded = await withTimeout(
        rpc(methods.agent.session.load, { sessionId: sessionA, cwd: workspace, mcpServers: [] }),
        60_000,
        'session/load',
      )
      const replayed = updates.slice(start)
        .filter(update => update.sessionUpdate === 'user_message_chunk'
          || update.sessionUpdate === 'agent_message_chunk')
        .map(update => textOfChunk(update.content))
        .join('')
      assert(
        Array.isArray(loaded.configOptions) && loaded.configOptions.length > 0,
        'load returned no config options',
      )
      assert(
        replayed.includes('Remember this codeword'),
        `load did not replay the user prompt: ${JSON.stringify(replayed.slice(0, 200))}`,
      )
      assert(
        replayed.includes('OK'),
        `load did not replay the assistant answer: ${JSON.stringify(replayed.slice(0, 200))}`,
      )
      assert(
        !replayed.includes('Current runtime context'),
        'load replayed model-facing runtime context as a user message',
      )
      openSessions.add(sessionA)
      await closeQuietly(sessionA)
      return { replayedChars: replayed.length }
    })

    await step('T12', 'delete a closed session', async () => {
      assert(sessionA !== undefined, 'prerequisite: no source session')
      await withTimeout(
        rpc(methods.agent.session.delete, { sessionId: sessionA }),
        30_000,
        'session/delete',
      )
      const listed = await withTimeout(rpc(methods.agent.session.list, {}), 30_000, 'session/list after delete')
      assert(
        !(listed.sessions ?? []).some(item => item.sessionId === sessionA),
        'deleted session is still listed',
      )
      try {
        await withTimeout(
          rpc(methods.agent.session.delete, { sessionId: sessionA }),
          30_000,
          'session/delete again',
        )
      } catch (error) {
        const text = describeError(error)
        assert(/not deletable/.test(text), `unexpected error: ${text}`)
        return { secondDeleteError: text }
      }
      throw new Error('deleting an absent session unexpectedly succeeded')
    })
  }

  await step('T10', 'fork rejects a session without a completed turn', async () => {
    const created = await withTimeout(
      rpc(methods.agent.session.new, { cwd: workspace, mcpServers: [] }),
      60_000,
      'session/new (empty)',
    )
    openSessions.add(created.sessionId)
    await closeQuietly(created.sessionId)
    try {
      await withTimeout(
        rpc(methods.agent.session.fork, { sessionId: created.sessionId, cwd: workspace, mcpServers: [] }),
        30_000,
        'session/fork (no turn)',
      )
    } catch (error) {
      const text = describeError(error)
      assert(/no completed turn/.test(text), `unexpected error: ${text}`)
      return { error: text }
    }
    throw new Error('fork of a session without a turn unexpectedly succeeded')
  })

  await step('T11', 'failed MCP connection rolls back session/new', async () => {
    try {
      await withTimeout(
        rpc(methods.agent.session.new, {
          cwd: workspace,
          mcpServers: [{
            name: 'missing',
            command: join(home, 'no-such-mcp-binary'),
            args: [],
            env: [],
          }],
        }),
        60_000,
        'session/new (bad MCP)',
      )
    } catch (error) {
      return { error: describeError(error) }
    }
    throw new Error('session/new with an unreachable MCP server unexpectedly succeeded')
  })

  await step('T13', 'delete rejects an active session', async () => {
    const created = await withTimeout(
      rpc(methods.agent.session.new, { cwd: workspace, mcpServers: [] }),
      60_000,
      'session/new (delete-active)',
    )
    openSessions.add(created.sessionId)
    try {
      await withTimeout(
        rpc(methods.agent.session.delete, { sessionId: created.sessionId }),
        30_000,
        'session/delete (active)',
      )
    } catch (error) {
      const text = describeError(error)
      assert(/is active/.test(text), `unexpected error: ${text}`)
      return { error: text }
    } finally {
      await closeQuietly(created.sessionId)
    }
    throw new Error('deleting an active session unexpectedly succeeded')
  })

  for (const sessionId of [...openSessions]) await closeQuietly(sessionId)

  return { home, workspace }
}

let outcome
try {
  outcome = await withTimeout(main(), RUN_TIMEOUT_MS, 'whole acceptance run')
} catch (error) {
  results.push({ id: 'RUN', title: 'driver run', status: 'fail', error: describeError(error) })
}

// Teardown: closing the connection ends the server's stdin, which is its
// bounded shutdown path; escalate only if the process outlives the grace period.
try {
  if (connection !== undefined) await connection.close()
} catch { /* the server may already be gone */ }
const settled = childExited === undefined
  ? { code: undefined, signal: undefined }
  : await Promise.race([childExited, delay(5_000).then(() => undefined)])
if (settled === undefined && child !== undefined) child.kill('SIGKILL')

if (outcome !== undefined && !KEEP) {
  await rm(outcome.home, { recursive: true, force: true }).catch(() => {})
  await rm(outcome.workspace, { recursive: true, force: true }).catch(() => {})
}

const report = {
  generatedAt: new Date().toISOString(),
  repoRoot,
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  smoke: SMOKE,
  serverVersion,
  results,
  serverStderrTail: serverStderr.split('\n').slice(-60).join('\n'),
}
await writeFile(join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
await writeFile(join(outputDir, 'report.md'), renderMarkdown(report))
console.log(renderMarkdown(report))
console.log(`\nreport.json: ${join(outputDir, 'report.json')}`)

function renderMarkdown(value) {
  const lines = [
    '# ACP acceptance report',
    '',
    `- When: ${value.generatedAt}`,
    `- Node: ${value.node} (${value.platform})`,
    `- Server version: ${value.serverVersion ?? 'unknown'}`,
    `- Mode: ${value.smoke ? 'smoke (no model turns)' : 'full'}`,
    '',
    '| ID | Case | Result | ms | Detail / error |',
    '|---|---|---|---|---|',
  ]
  for (const result of value.results) {
    const detail = result.status === 'pass'
      ? JSON.stringify(result.detail ?? {})
      : result.status === 'skip' ? result.reason : result.error
    lines.push(`| ${result.id} | ${result.title} | ${result.status} | ${result.ms ?? ''} | ${cell(detail)} |`)
  }
  const failed = value.results.filter(result => result.status === 'fail').length
  lines.push('', failed === 0 ? 'All executed cases passed.' : `${failed} case(s) failed.`)
  lines.push('', '<details><summary>server stderr tail</summary>', '', '```', value.serverStderrTail, '```', '</details>')
  return `${lines.join('\n')}\n`
}

function cell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}
