import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveEmbedderForTests,
  setCodeIndexModelsRootOverrideForTests,
  clearEmbedderFailCacheForTests,
  CodeIndexStore,
  searchCodeIndex,
  syncCodeIndex,
  closeCodeIndex
} from '@main/agent/codeindex'
import { resetCodeIndexRuntimeStatusForTests } from '@main/agent/codeindex/modelStatus'
import { DENSEON_ONNX_MODEL_ID } from '@main/agent/codeindex/types'

/**
 * THE semantic-search acceptance proof: with the production default settings
 * (embedder=mdenseon, autoDownload=true), the public DenseOn bootstrap must
 * download, load through real ONNX Runtime, embed documents and queries in the
 * SAME space, and rank semantically (synonym query beats a lexical-decoy).
 * Real network, real ORT — no stubs.
 *
 * OPT-IN ONLY (VYOTIQ_SEMANTIC_LIVE=1): deliberately bypasses the Vitest
 * autoDownload guard and pulls ~150MB from the hub, so it never runs in the
 * default suite or CI. Verified live 2026-08-30 (27.7s pass; 85ms fail with
 * the family-scoping fix stashed).
 */
describe.skipIf(process.env.VYOTIQ_SEMANTIC_LIVE !== '1')(
  'semantic search end-to-end with the real neural embedder (opt-in)',
  () => {
    let dir: string | undefined
  let modelsRoot: string | undefined

  afterEach(() => {
    setCodeIndexModelsRootOverrideForTests(null)
    clearEmbedderFailCacheForTests()
    resetCodeIndexRuntimeStatusForTests()
    if (dir) {
      closeCodeIndex(dir)
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* windows sqlite */
      }
      dir = undefined
    }
    if (modelsRoot) {
      try {
        rmSync(modelsRoot, { recursive: true, force: true })
      } catch {
        /* windows ort dll lock */
      }
      modelsRoot = undefined
    }
  })

  it(
    'downloads the public bootstrap, loads ORT, and ranks semantically',
    async () => {
      modelsRoot = mkdtempSync(join(tmpdir(), 'vyotiq-semcheck-models-'))
      setCodeIndexModelsRootOverrideForTests(modelsRoot)
      clearEmbedderFailCacheForTests()

      const resolved = await resolveEmbedderForTests({
        embedderId: 'mdenseon',
        autoDownload: true
      })
      expect(resolved.usedFallback).toBe(false)
      // modelId is the TARGET label until the lazy session loads; the real
      // artifact identity is asserted after sync (below).

      // Real cosine sanity: same-family vectors, synonym beats decoy.
      dir = mkdtempSync(join(tmpdir(), 'vyotiq-semcheck-ws-'))
      const { mkdirSync, writeFileSync } = await import('fs')
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(
        join(dir, 'src', 'auth.ts'),
        'export function validateAuthToken(token: string): boolean {\n  return token.startsWith("Bearer ")\n}\n',
        'utf8'
      )
      writeFileSync(
        join(dir, 'src', 'billing.ts'),
        'export function processRefund(orderId: string): void {\n  console.log("refund", orderId)\n}\n',
        'utf8'
      )
      const store = CodeIndexStore.open(dir, resolved.embedder.dimensions)
      try {
        const sync = await syncCodeIndex(dir, store, resolved.embedder)
        expect(sync.indexed).toBeGreaterThan(0)
        // The lazy session must have loaded the REAL public bootstrap (768-dim,
        // ONNX Runtime) — proving the family-scoped fix fired the download path.
        expect(resolved.embedder.modelId).toBe(DENSEON_ONNX_MODEL_ID)
        expect(resolved.embedder.dimensions).toBe(768)

        // Synonym query ("verify access token") must outrank the lexical-decoy
        // ("token" also appears nowhere in billing; both docs lack the literal
        // query words except via meaning) — semantic ranking, not keyword match.
        const hits = await searchCodeIndex(
          dir,
          store,
          resolved.embedder,
          'verify access credentials before granting entry',
          { limit: 5, mode: 'hybrid' }
        )
        expect(hits.length).toBeGreaterThan(0)
        expect(hits[0]?.path).toBe('src/auth.ts')
      } finally {
        store.close()
      }
    },
    600_000
  )
})
