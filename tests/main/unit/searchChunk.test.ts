import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { toolSearch } from '@main/agent/tools/search'

describe('toolSearch chunking', () => {
  it('aborts during a large workspace scan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-search-chunk-'))
    for (let i = 0; i < 120; i++) {
      const sub = join(dir, `dir-${i}`)
      mkdirSync(sub)
      writeFileSync(join(sub, `file-${i}.ts`), `export const token${i} = ${i}\n`, 'utf8')
    }

    const ac = new AbortController()
    const searchPromise = toolSearch(dir, 'token', 40, ac.signal)
    ac.abort()

    await expect(searchPromise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('finds matches across many files without blocking forever', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-search-many-'))
    for (let i = 0; i < 80; i++) {
      writeFileSync(join(dir, `f-${i}.ts`), `const needle = ${i}\n`, 'utf8')
    }

    const hits = await toolSearch(dir, 'needle', 5)
    expect(hits).toMatch(/f-\d+\.ts/)
    // Truncation appends a '… stopped at N matches' notice line beyond the hits.
    const hitLines = hits.split('\n').filter((line) => !line.startsWith('…'))
    expect(hitLines.length).toBeLessThanOrEqual(5)
  })
})
