import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const querySparseCandidates = vi.fn()

vi.mock('@main/agent/sparsegrep', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/sparsegrep')>()
  return {
    ...actual,
    querySparseCandidates: (...args: unknown[]) => querySparseCandidates(...args)
  }
})

vi.mock('@main/agent/tools/walk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/tools/walk')>()
  return {
    ...actual,
    collectWorkspaceFiles: async (root: string) => [
      { full: join(root, 'prefix.ts'), rel: 'prefix.ts' }
    ]
  }
})

import { toolSearch } from '@main/agent/tools/search'

describe('toolSearch sparse candidates', () => {
  let root: string

  afterEach(() => {
    querySparseCandidates.mockReset()
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  })

  it('content-searches sparse hits even when they are outside the filename walk prefix', async () => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-search-sparse-'))
    writeFileSync(join(root, 'prefix.ts'), 'export const prefixOnly = 1\n', 'utf8')
    mkdirSync(join(root, 'deep'), { recursive: true })
    writeFileSync(join(root, 'deep', 'hit.ts'), 'export const uniqueSparseMarker = 1\n', 'utf8')
    querySparseCandidates.mockResolvedValue({
      lookup: { ok: true, paths: ['deep/hit.ts'], mode: 'trigram' },
      fileCount: 2,
      syncComplete: true
    })
    const out = await toolSearch(root, 'uniqueSparseMarker', 10)
    expect(out).toMatch(/deep\/hit\.ts/)
    expect(out).toMatch(/index=trigram/)
  })
})
