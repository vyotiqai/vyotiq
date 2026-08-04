import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadToolCatalogSticky, saveToolCatalogSticky } from '@main/agent/state'

describe('toolCatalog sticky persistence', () => {
  let runDir: string

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'vyotiq-toolcat-'))
  })

  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true })
  })

  it('round-trips mcpLastUsedByName with kept names', () => {
    const ok = saveToolCatalogSticky(
      runDir,
      ['read', 'mcp__srv__a', 'mcp__srv__b'],
      'fp-1',
      new Map([
        ['mcp__srv__a', 3],
        ['mcp__srv__b', 7]
      ])
    )
    expect(ok).toBe(true)
    const loaded = loadToolCatalogSticky(runDir)
    expect(loaded).toMatchObject({
      version: 1,
      keptNames: ['read', 'mcp__srv__a', 'mcp__srv__b'],
      fingerprint: 'fp-1',
      mcpLastUsedByName: {
        'mcp__srv__a': 3,
        'mcp__srv__b': 7
      }
    })
  })

  it('loads legacy catalogs without last-used stamps', () => {
    writeFileSync(
      join(runDir, 'toolCatalog.json'),
      JSON.stringify({
        version: 1,
        keptNames: ['read', 'mcp__old__x'],
        fingerprint: 'legacy',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }),
      'utf8'
    )
    const loaded = loadToolCatalogSticky(runDir)
    expect(loaded?.keptNames).toEqual(['read', 'mcp__old__x'])
    expect(loaded?.mcpLastUsedByName).toBeUndefined()
  })

  it('ignores invalid last-used entries on load', () => {
    writeFileSync(
      join(runDir, 'toolCatalog.json'),
      JSON.stringify({
        version: 1,
        keptNames: ['mcp__srv__ok'],
        fingerprint: 'fp',
        updatedAt: '2026-08-02T00:00:00.000Z',
        mcpLastUsedByName: {
          'mcp__srv__ok': 4,
          read: 9,
          'mcp__bad': 0,
          'mcp__nan': Number.NaN
        }
      }),
      'utf8'
    )
    const loaded = loadToolCatalogSticky(runDir)
    expect(loaded?.mcpLastUsedByName).toEqual({ 'mcp__srv__ok': 4 })
    // Ensure disk write omits garbage when re-saved via Map
    saveToolCatalogSticky(runDir, loaded!.keptNames, loaded!.fingerprint, loaded!.mcpLastUsedByName)
    const raw = JSON.parse(readFileSync(join(runDir, 'toolCatalog.json'), 'utf8'))
    expect(raw.mcpLastUsedByName).toEqual({ 'mcp__srv__ok': 4 })
  })
})
