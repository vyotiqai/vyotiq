import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, promises as fsp } from 'fs'
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

  it('reads a small file', async () => {
    expect(await toolRead(root, 'hello.txt')).toBe('hello world')
  })

  it('reads files larger than the former 512 KiB full-read cap', async () => {
    const body = 'x'.repeat(512 * 1024 + 80)
    writeFileSync(join(root, 'over-old-cap.txt'), body, 'utf8')
    expect(await toolRead(root, 'over-old-cap.txt')).toBe(body)
  })

  it('lists directory contents instead of throwing not-a-file', async () => {
    const out = await toolRead(root, 'subdir')
    expect(out).toContain('Path is a directory')
    expect(out).toContain('nested.txt')
  })

  it('suggests similar names when file is missing', async () => {
    try {
      await toolRead(root, 'hell.txt')
      expect.fail('expected throw')
    } catch (err) {
      expect(String(err)).toContain('File not found')
      expect(String(err)).toContain('hello.txt')
    }
  })

  it('supports offset/limit for partial reads', async () => {
    const out = await toolRead(root, 'hello.txt', { offset: 6, limit: 5 })
    expect(out).toContain('world')
  })

  it('rejects binary files on the offset/limit path too', async () => {
    await expect(toolRead(root, 'binary.dat', { offset: 1, limit: 2 })).rejects.toThrow(
      /Binary file detected: binary\.dat\. Read is text-only\./
    )
    // A window with no NUL is treated as text — mid-file has no BOM to inspect.
    const out = await toolRead(root, 'binary.dat', { offset: 2 })
    expect(out).toContain('BC')
  })

  it('rejects binary files on full and line-range reads', async () => {
    await expect(toolRead(root, 'binary.dat')).rejects.toThrow(/Binary file detected/)
    await expect(toolRead(root, 'binary.dat', { startLine: 1 })).rejects.toThrow(/Binary file detected/)
  })

  it('reads UTF-16 LE BOM text (PowerShell log pattern)', async () => {
    const utf16Path = join(root, 'utf16le.log')
    const body = 'download started\r\nline two'
    const buf = Buffer.alloc(2 + body.length * 2)
    buf[0] = 0xff
    buf[1] = 0xfe
    for (let i = 0; i < body.length; i++) {
      buf[2 + i * 2] = body.charCodeAt(i)
      buf[2 + i * 2 + 1] = 0
    }
    writeFileSync(utf16Path, buf)
    expect(await toolRead(root, 'utf16le.log')).toBe('download started\r\nline two')
  })

  it('reads UTF-16 LE BOM text with offset/limit', async () => {
    const utf16Path = join(root, 'utf16-offset.log')
    const body = 'download started\r\nline two'
    const buf = Buffer.alloc(2 + body.length * 2)
    buf[0] = 0xff
    buf[1] = 0xfe
    for (let i = 0; i < body.length; i++) {
      buf[2 + i * 2] = body.charCodeAt(i)
      buf[2 + i * 2 + 1] = 0
    }
    writeFileSync(utf16Path, buf)
    const out = await toolRead(root, 'utf16-offset.log', { offset: 0, limit: 20 })
    expect(out).toContain('download')
    expect(out).not.toContain('line two')
  })

  it('streams a byte window on large files', async () => {
    const bigPath = join(root, 'big-offset.txt')
    writeFileSync(bigPath, 'x'.repeat(512 * 1024 + 1))
    const out = await toolRead(root, 'big-offset.txt', { offset: 0, limit: 10 })
    expect(out).toContain('--- offset 0, limit 10')
    expect(out).toContain('xxxxxxxxxx')
    expect(out).not.toMatch(/File too large/)
  })

  it('returns an inclusive line range with a header naming it', async () => {
    const out = await toolRead(root, 'lines.txt', { startLine: 2, endLine: 4 })
    expect(out).toBe('--- lines 2-4 of 5 ---\ntwo\nthree\nfour')
  })

  it('swaps inverted startLine/endLine and reads that window', async () => {
    writeFileSync(
      join(root, 'many-lines.txt'),
      Array.from({ length: 25 }, (_, i) => `L${i + 1}`).join('\n')
    )
    const out = await toolRead(root, 'many-lines.txt', { startLine: 20, endLine: 5 })
    expect(out).toMatch(/^--- lines 5-20 of 25 ---/)
    const body = out.split('\n').slice(1)
    expect(body[0]).toBe('L5')
    expect(body[body.length - 1]).toBe('L20')
    expect(body).toHaveLength(16)
  })

  it('runs to the end of the file when endLine is omitted', async () => {
    const out = await toolRead(root, 'lines.txt', { startLine: 4 })
    expect(out).toBe('--- lines 4-5 of 5 ---\nfour\nfive')
  })

  it('clamps an endLine past the end rather than padding blank lines', async () => {
    const out = await toolRead(root, 'lines.txt', { startLine: 5, endLine: 900 })
    expect(out).toBe('--- lines 5-5 of 5 ---\nfive')
  })

  it('refuses a startLine past the end instead of returning nothing', async () => {
    await expect(toolRead(root, 'lines.txt', { startLine: 12 })).rejects.toThrow(/past the end/)
  })

  it('does not count a trailing newline as an extra line', async () => {
    expect(await toolRead(root, 'lines.txt', { startLine: 1 })).toContain('of 5 ---')
  })

  it('streams a requested line range in full without a returned-text cap', async () => {
    const line = 'y'.repeat(200)
    const count = 400
    writeFileSync(join(root, 'big-lines.txt'), Array.from({ length: count }, () => line).join('\n'))
    const out = await toolRead(root, 'big-lines.txt', { startLine: 10, endLine: 12 })
    expect(out).toMatch(/^--- lines 10-12 of 400 ---/)
    expect(out).not.toMatch(/capped/)
    expect(out).toContain(line)
    const body = out.split('\n').slice(1)
    expect(body).toHaveLength(3)
    expect(body.every((row) => row === line)).toBe(true)
  })

  it('overlaps I/O for two concurrent reads of different files', async () => {
    writeFileSync(join(root, 'overlap-a.txt'), 'alpha', 'utf8')
    writeFileSync(join(root, 'overlap-b.txt'), 'bravo', 'utf8')

    let inFlight = 0
    let maxConcurrent = 0
    const origReadFile = fsp.readFile.bind(fsp)
    const spy = vi.spyOn(fsp, 'readFile').mockImplementation((async (...args: unknown[]) => {
      inFlight += 1
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      await new Promise((r) => setTimeout(r, 40))
      try {
        return await origReadFile(...(args as Parameters<typeof origReadFile>))
      } finally {
        inFlight -= 1
      }
    }) as typeof fsp.readFile)

    try {
      const [a, b] = await Promise.all([
        toolRead(root, 'overlap-a.txt'),
        toolRead(root, 'overlap-b.txt')
      ])
      expect(a).toBe('alpha')
      expect(b).toBe('bravo')
      expect(maxConcurrent).toBeGreaterThan(1)
    } finally {
      spy.mockRestore()
    }
  })
})
