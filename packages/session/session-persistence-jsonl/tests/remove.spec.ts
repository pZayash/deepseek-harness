import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

describe('JSONL session deletion', () => {
  it('emits session/deleted and leaves no visible session directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jsonl-delete-'))
    const ctx = new Context()
    const fiber = await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
    const deleted: string[] = []
    ctx.on('session/deleted', (id) => { deleted.push(id) })
    try {
      const m = meta('delete-event', '/work')
      const handle = await ctx.sessionPersistence.create(m)
      await handle.append(oneTurnLog())
      await handle.close()

      await ctx.sessionPersistence.remove(m.id)

      expect(deleted).toEqual([m.id])
      expect(await ctx.sessionPersistence.list()).toEqual([])
    } finally {
      await fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
