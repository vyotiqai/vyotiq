import { describe, expect, it } from 'vitest'
import { toolEdit } from '@main/agent/tools/edit'
import { toolMultiEdit } from '@main/agent/tools/multiEdit'
import {
  assertWritableTextContent,
  LARGE_WRITE_MAX_CHARS,
  LARGE_WRITE_MAX_LINES,
  validateWriteToolCall
} from '@main/agent/tools/writeGuard'
import { mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('writeGuard', () => {
  it('rejects oversized single-file writes', () => {
    expect(() => assertWritableTextContent('notes.txt', 'x'.repeat(LARGE_WRITE_MAX_CHARS + 1))).toThrow(
      /Write too large/
    )
  })

  it('rejects writes with too many lines', () => {
    const lines = Array.from({ length: LARGE_WRITE_MAX_LINES + 1 }, (_, i) => `line ${i}`).join('\n')
    expect(() => assertWritableTextContent('dump.txt', lines)).toThrow(/Write too large/)
  })

  it('rejects text writes to binary extensions', () => {
    expect(() => assertWritableTextContent('model.gguf', 'not binary')).toThrow(/binary path/)
  })

  it('validateWriteToolCall rejects edit args before execution', () => {
    expect(() =>
      validateWriteToolCall(
        'edit',
        JSON.stringify({ path: 'scrape.md', contents: 'x'.repeat(LARGE_WRITE_MAX_CHARS + 1) })
      )
    ).toThrow(/Write too large/)
  })

  it('validateWriteToolCall rejects multi_edit args before execution', () => {
    expect(() =>
      validateWriteToolCall(
        'multi_edit',
        JSON.stringify({
          edits: [{ path: 'a.md', contents: 'ok' }, { path: 'b.md', contents: 'y'.repeat(LARGE_WRITE_MAX_CHARS + 1) }]
        })
      )
    ).toThrow(/Write too large/)
  })

  it('validateWriteToolCall checks str_replace resulting file size', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-write-guard-str-'))
    writeFileSync(join(dir, 'src.txt'), 'tiny')
    expect(() =>
      validateWriteToolCall(
        'str_replace',
        JSON.stringify({
          path: 'src.txt',
          old_string: 'tiny',
          new_string: 'z'.repeat(LARGE_WRITE_MAX_CHARS + 1)
        }),
        dir
      )
    ).toThrow(/Write too large/)
  })

  it('validateWriteToolCall checks edit diff resulting file size', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-write-guard-diff-'))
    writeFileSync(join(dir, 'src.txt'), 'hello')
    expect(() =>
      validateWriteToolCall(
        'edit',
        JSON.stringify({
          path: 'src.txt',
          diff: '@@ -1 +1 @@\n-hello\n+' + 'z'.repeat(LARGE_WRITE_MAX_CHARS + 1)
        }),
        dir
      )
    ).toThrow(/Write too large/)
  })

  it('toolEdit enforces the cap on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-write-guard-'))
    expect(() => toolEdit(dir, 'big.txt', 'z'.repeat(LARGE_WRITE_MAX_CHARS + 1), undefined)).toThrow(
      /Write too large/
    )
  })

  it('toolMultiEdit enforces the cap on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-write-guard-multi-'))
    expect(() =>
      toolMultiEdit(dir, [{ path: 'big.txt', contents: 'z'.repeat(LARGE_WRITE_MAX_CHARS + 1) }])
    ).toThrow(/Write too large/)
  })
})
