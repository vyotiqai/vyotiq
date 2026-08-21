/**
 * Audit repro: grep/glob walks are unbounded in production.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { toolGrep } from '@main/agent/tools/grep'
import { toolGlob } from '@main/agent/tools/glob'

describe('audit: large repo scans are unbounded', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  function buildTree(fileCount: number): string {
    const root = join(tmpdir(), `vyotiq-audit-${process.pid}-${fileCount}`)
    roots.push(root)
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    for (let i = 0; i < fileCount; i++) {
      const dir = join(root, `pkg${Math.floor(i / 100)}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `file${i}.ts`), `export const TARGET_${i} = 'needle'\n`, 'utf8')
    }
    return root
  }

  it('finds late-tree matches without a scan-cap notice', async () => {
    const fileCount = 250
    const root = buildTree(fileCount)
    const out = await toolGrep(root, `TARGET_${fileCount - 1}`)
    expect(out).toMatch(new RegExp(`TARGET_${fileCount - 1}`))
    expect(out).not.toMatch(/scan cap/i)
  }, 60_000)

  it('lists every glob match without a scan-cap notice', async () => {
    const fileCount = 250
    const root = buildTree(fileCount)
    const out = await toolGlob(root, '**/*.ts')
    expect(out).toContain(`file${fileCount - 1}.ts`)
    expect(out).not.toMatch(/scan cap/i)
  }, 60_000)
})
