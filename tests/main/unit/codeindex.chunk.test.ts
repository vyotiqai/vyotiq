import { describe, expect, it } from 'vitest'
import { chunkSource } from '@main/agent/codeindex/chunk'
import {
  chunkSourceAst,
  codeindexWasmCandidateDirs,
  treeSitterReady
} from '@main/agent/codeindex/chunkAst'
import type { CodeChunk } from '@main/agent/codeindex/types'

const BANNER_APPLY_STATE = `/**
 * Cosmetic filter engine.
 * How does the popup toggle the network blocking UI
 * for every site the user visits.
 */

/**
 * Build dynamic allow rules for whitelisted sites.
 */
export function applyState() {
  chrome.declarativeNetRequest.updateDynamicRules({ addRules: [] })
}

// later trailing comment about the whitelist UI
export function otherHelper() {
  return 1
}
`

function assertModuleContextSkipsApplyState(chunks: CodeChunk[]): void {
  const apply = chunks.find((c) => c.name === 'applyState')
  expect(apply).toBeTruthy()
  expect(apply!.text).toContain('updateDynamicRules')
  const modules = chunks.filter((c) => c.name === 'module_context')
  expect(modules.length).toBeGreaterThan(0)
  for (const m of modules) {
    expect(m.text).not.toContain('function applyState')
    expect(m.text).not.toContain('updateDynamicRules')
    expect(m.endLine < apply!.startLine || m.startLine > apply!.endLine).toBe(true)
  }
}

describe('codeindex chunkSource', () => {
  it('chunks TypeScript functions without cutting mid-body', () => {
    const src = `
import { x } from './x'

export function validateAuth(token: string): boolean {
  if (!token) return false
  return token.startsWith('Bearer ')
}

export class AuthService {
  verify(userId: string): boolean {
    return userId.length > 0
  }
}
`
    const chunks = chunkSource('src/auth.ts', src)
    const names = chunks.map((c) => c.name)
    expect(names).toContain('validateAuth')
    expect(names).not.toContain('AuthService')
    const method = chunks.find((c) => c.name === 'verify')
    expect(method).toBeTruthy()
    expect(method!.parentName).toBe('AuthService')
    const fn = chunks.find((c) => c.name === 'validateAuth')!
    expect(fn.text).toContain('token.startsWith')
    expect(fn.contextualizedText).toContain('file: src/auth.ts')
    expect(fn.startLine).toBeLessThan(fn.endLine)
    // No chunk should end mid-brace of validateAuth only halfway
    expect(fn.text.trim().endsWith('}')).toBe(true)
  })

  it('chunks Python defs by indent', () => {
    const src = `
def process_refund(order_id: str) -> None:
    amount = lookup(order_id)
    if amount > 0:
        charge(amount)

class Ledger:
    def apply(self, n: int) -> int:
        return n + 1
`
    const chunks = chunkSource('billing/refund.py', src)
    expect(chunks.some((c) => c.name === 'process_refund')).toBe(true)
    expect(chunks.some((c) => c.name === 'Ledger')).toBe(false)
    const apply = chunks.find((c) => c.name === 'apply')
    expect(apply).toBeTruthy()
    expect(apply!.parentName).toBe('Ledger')
    const refund = chunks.find((c) => c.name === 'process_refund')!
    expect(refund.text).toContain('charge(amount)')
  })

  it('does not chunk nested Python defs', () => {
    const src = `
def process_refund(order_id: str) -> None:
    def helper(n: int) -> int:
        return n + 1
    charge(helper(1))
`
    const chunks = chunkSource('billing/refund.py', src)
    expect(chunks.some((c) => c.name === 'process_refund')).toBe(true)
    expect(chunks.some((c) => c.name === 'helper')).toBe(false)
    const refund = chunks.find((c) => c.name === 'process_refund')!
    expect(refund.text).toContain('def helper')
  })

  it('chunks markdown by headings', () => {
    const src = `# Title\n\nIntro\n\n## Auth\n\nDetails about login.\n`
    const chunks = chunkSource('README.md', src)
    expect(chunks.some((c) => c.name === 'Auth')).toBe(true)
  })

  it('module_context covers banner+JSDoc orphans without spanning applyState', () => {
    assertModuleContextSkipsApplyState(chunkSource('background/service-worker.js', BANNER_APPLY_STATE))
  })
})

describe('codeindex chunkSourceAst (web-tree-sitter)', () => {
  it('resolves packaged/dev wasm candidate dirs including resources/codeindex/wasm', () => {
    const dirs = codeindexWasmCandidateDirs()
    expect(dirs.some((d) => d.replace(/\\/g, '/').endsWith('resources/codeindex/wasm'))).toBe(
      true
    )
  })

  it('loads WASM and chunks TypeScript without mid-function cuts', async () => {
    const ready = await treeSitterReady()
    expect(ready).toBe(true)
    const src = `
import { x } from './x'

export function validateAuth(token: string): boolean {
  if (!token) return false
  const nested = () => {
    return token.length
  }
  return token.startsWith('Bearer ')
}

export class AuthService {
  verify(userId: string): boolean {
    return userId.length > 0
  }
}
`
    const chunks = await chunkSourceAst('src/auth.ts', src)
    const fn = chunks.find((c) => c.name === 'validateAuth')
    expect(fn).toBeTruthy()
    expect(fn!.text).toContain('token.startsWith')
    expect(fn!.text).toContain('nested')
    expect(fn!.text.trim().endsWith('}')).toBe(true)
    expect(fn!.contextualizedText).toContain('file: src/auth.ts')
    const cls = chunks.find((c) => c.name === 'AuthService')
    expect(cls).toBeUndefined()
    const method = chunks.find((c) => c.name === 'verify')
    expect(method).toBeTruthy()
    expect(method!.parentName === 'AuthService' || method!.kind === 'method').toBe(true)
    expect(chunks.some((c) => c.name === 'nested')).toBe(false)
  })

  it('does not embed nested closures or type-only declarations', async () => {
    const ready = await treeSitterReady()
    expect(ready).toBe(true)
    const src = `
export interface AuthToken { value: string }
export type AuthResult = boolean
export enum AuthKind { Bearer }

export function validateAuth(token: string): boolean {
  const nested = () => token.length
  const again = () => nested()
  return token.startsWith('Bearer ')
}

export const loadSession = async () => {
  const inner = () => 1
  return inner()
}
`
    const chunks = await chunkSourceAst('src/auth.ts', src)
    const names = chunks.map((c) => c.name)
    expect(names).toContain('validateAuth')
    expect(names).toContain('loadSession')
    expect(names).not.toContain('AuthToken')
    expect(names).not.toContain('AuthResult')
    expect(names).not.toContain('AuthKind')
    expect(names).not.toContain('nested')
    expect(names).not.toContain('again')
    expect(names).not.toContain('inner')
    const fn = chunks.find((c) => c.name === 'validateAuth')!
    expect(fn.text).toContain('const nested')
    expect(fn.text).toContain('const again')
  })

  it('chunks Python without cutting mid-def', async () => {
    const src = `
def process_refund(order_id: str) -> None:
    def helper(n: int) -> int:
        return n + 1
    amount = lookup(order_id)
    if amount > 0:
        charge(amount)

class Ledger:
    def apply(self, n: int) -> int:
        return n + 1
`
    const chunks = await chunkSourceAst('billing/refund.py', src)
    const refund = chunks.find((c) => c.name === 'process_refund')
    expect(refund).toBeTruthy()
    expect(refund!.text).toContain('charge(amount)')
    expect(refund!.text).toContain('def helper')
    expect(chunks.some((c) => c.name === 'helper')).toBe(false)
    expect(chunks.some((c) => c.name === 'Ledger')).toBe(false)
    const apply = chunks.find((c) => c.name === 'apply')
    expect(apply).toBeTruthy()
    expect(apply!.parentName).toBe('Ledger')
  })

  it('falls back for markdown (unsupported grammar)', async () => {
    const src = `# Title\n\nIntro\n\n## Auth\n\nDetails about login.\n`
    const chunks = await chunkSourceAst('README.md', src)
    expect(chunks.some((c) => c.name === 'Auth')).toBe(true)
  })

  it('module_context covers banner+JSDoc orphans without spanning applyState', async () => {
    const ready = await treeSitterReady()
    expect(ready).toBe(true)
    assertModuleContextSkipsApplyState(
      await chunkSourceAst('background/service-worker.js', BANNER_APPLY_STATE)
    )
  })
})
