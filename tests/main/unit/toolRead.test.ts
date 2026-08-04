import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { toolRead } from '@main/agent/tools/read'

describe('toolRead', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-read-'))
    mkdirSync(join(root, 'subdir'), { recursive: true })
    writeFileSync(join(root, 'hello.txt'), 'hello world', 'utf8')
    writeFileSync(join(root, 'subdir', 'nested.txt'), 'nested', 'utf8')
    writeFileSync(join(root, 'lines.txt'), 'one\ntwo\nthree\nfour\nfive\n', 'utf8')
    writeFileSync(join(root, 'binary.dat'), Buffer.from([0x41, 0x00, 0x42, 0x43]))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('reads a small file', () => {
    expect(toolRead(root, 'hello.txt')).toBe('hello world')
  })

  it('exports a content cap of 512 KiB', async () => {
    const { READ_CONTENT_CAP } = await import('@main/agent/tools/read')
    expect(READ_CONTENT_CAP).toBe(512 * 1024)
  })

  it('lists directory contents instead of throwing not-a-file', () => {
    const out = toolRead(root, 'subdir')
    expect(out).toContain('Path is a directory')
    expect(out).toContain('nested.txt')
  })

  it('suggests similar names when file is missing', () => {
    try {
      toolRead(root, 'hell.txt')
      expect.fail('expected throw')
    } catch (err) {
      expect(String(err)).toContain('File not found')
      expect(String(err)).toContain('hello.txt')
    }
  })

  it('supports offset/limit for partial reads', () => {
    const out = toolRead(root, 'hello.txt', { offset: 6, limit: 5 })
    expect(out).toContain('world')
  })

  it('rejects binary files on the offset/limit path too', () => {
    expect(() => toolRead(root, 'binary.dat', { offset: 1, limit: 2 })).toThrow(
      /Binary file detected: binary\.dat\. Read is text-only\./
    )
    expect(() => toolRead(root, 'binary.dat', { offset: 2 })).toThrow(/Binary file detected/)
  })

  it('rejects binary files on full and line-range reads', () => {
    expect(() => toolRead(root, 'binary.dat')).toThrow(/Binary file detected/)
    expect(() => toolRead(root, 'binary.dat', { startLine: 1 })).toThrow(/Binary file detected/)
  })

  it('returns an inclusive line range with a header naming it', () => {
    const out = toolRead(root, 'lines.txt', { startLine: 2, endLine: 4 })
    expect(out).toBe('--- lines 2-4 of 5 ---\ntwo\nthree\nfour')
  })

  it('runs to the end of the file when endLine is omitted', () => {
    const out = toolRead(root, 'lines.txt', { startLine: 4 })
    expect(out).toBe('--- lines 4-5 of 5 ---\nfour\nfive')
  })

  it('clamps an endLine past the end rather than padding blank lines', () => {
    const out = toolRead(root, 'lines.txt', { startLine: 5, endLine: 900 })
    expect(out).toBe('--- lines 5-5 of 5 ---\nfive')
  })

  it('refuses a startLine past the end instead of returning nothing', () => {
    expect(() => toolRead(root, 'lines.txt', { startLine: 12 })).toThrow(/past the end/)
  })

  it('does not count a trailing newline as an extra line', () => {
    expect(toolRead(root, 'lines.txt', { startLine: 1 })).toContain('of 5 ---')
  })
})
