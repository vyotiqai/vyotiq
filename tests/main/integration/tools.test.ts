import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyUnifiedDiff, toolEdit } from '@main/agent/tools/edit'
import { toolSearch } from '@main/agent/tools/search'
import { toolRead } from '@main/agent/tools/read'
import { executeTool } from '@main/agent/tools'

describe('tools', () => {
  it('applies unified diff and writes via toolEdit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-tools-'))
    const original = 'line1\nline2\nline3\n'
    const diff = `@@ -1,3 +1,3 @@
 line1
-line2
+line2-changed
 line3
`
    expect(applyUnifiedDiff(original, diff)).toBe('line1\nline2-changed\nline3\n')

    writeFileSync(join(dir, 'a.txt'), original, 'utf8')
    toolEdit(dir, 'a.txt', undefined, diff)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toContain('line2-changed')

    toolEdit(dir, 'b/new.txt', 'hello', undefined)
    expect(readFileSync(join(dir, 'b', 'new.txt'), 'utf8')).toBe('hello')
  })

  it('rejects path escapes on edit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-tools-'))
    const signal = new AbortController().signal
    await expect(
      executeTool('edit', JSON.stringify({ path: '../escape.txt', contents: 'x' }), dir, signal)
    ).resolves.toMatchObject({ ok: false })
  })

  it('rejects empty search query (would otherwise match everything)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-search-empty-'))
    writeFileSync(join(dir, 'a.ts'), 'x\n', 'utf8')
    await expect(toolSearch(dir, '  ', 40)).rejects.toThrow(/required/i)
  })

  it('search is substring not regex', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-search-'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'const foo = 1\n', 'utf8')
    writeFileSync(join(dir, 'src', 'b.ts'), 'const bar = 2\n', 'utf8')

    const hits = await toolSearch(dir, 'foo', 40)
    expect(hits).toMatch(/a\.ts/)
    expect(hits).not.toMatch(/b\.ts/)

    const literal = await toolSearch(dir, 'foo.*', 40)
    expect(literal).toMatch(/No matches/i)
  })

  it('honors AbortSignal on search/read/edit path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-abort-'))
    writeFileSync(join(dir, 'x.txt'), 'hello', 'utf8')
    const ac = new AbortController()
    ac.abort()
    await expect(
      executeTool('read', JSON.stringify({ path: 'x.txt' }), dir, ac.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('reads files inside workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-read-'))
    writeFileSync(join(dir, 'r.txt'), 'payload', 'utf8')
    expect(toolRead(dir, 'r.txt')).toBe('payload')
  })

  it('reads and writes memory tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-mem-tools-'))
    const signal = new AbortController().signal
    const write = await executeTool(
      'memory_write',
      JSON.stringify({ path: 'notes/t.md', contents: 'note' }),
      dir,
      signal
    )
    expect(write.ok).toBe(true)
    const read = await executeTool(
      'memory_read',
      JSON.stringify({ path: 'notes/t.md' }),
      dir,
      signal
    )
    expect(read.content).toContain('note')
    const list = await executeTool('memory_list', '{}', dir, signal)
    expect(list.content).toContain('t.md')
  })
})
