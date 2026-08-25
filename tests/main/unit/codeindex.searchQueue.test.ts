import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node-llama-cpp', () => ({
  getLlama: vi.fn().mockRejectedValue(new Error('node-llama-cpp mocked unavailable in unit tests')),
  resolveModelFile: vi.fn()
}))

const { searchCodeMock, canUseIndexSearchUtilityMock } = vi.hoisted(() => ({
  searchCodeMock: vi.fn(),
  canUseIndexSearchUtilityMock: vi.fn(() => true)
}))

vi.mock('@main/agent/codeindex/embedUtilityClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/codeindex/embedUtilityClient')>()
  return {
    ...actual,
    canUseIndexSearchUtility: () => canUseIndexSearchUtilityMock(),
    getEmbedUtilityClient: () => ({
      searchCode: searchCodeMock
    })
  }
})

import {
  closeCodeIndex,
  CodeIndexStore,
  disposeCodeIndexWorkspace,
  runCodebaseSearch
} from '@main/agent/codeindex'
import { DEFAULT_EMBED_DIM } from '@main/agent/codeindex/types'
import {
  activeIndexJobPreemptSignal,
  enqueueIndexJob,
  indexJobQueueActivePriorityForTests,
  indexJobQueuePendingInteractiveCountForTests,
  resetIndexJobQueueForTests
} from '@main/agent/indexJobQueue'
import {
  setWorkspaceIndexStorageRootOverrideForTests
} from '@main/agent/indexStoragePaths'
import {
  clearWorkspaceIndexSyncTimers,
  disposeWorkspaceIndexes
} from '@main/agent/workspaceIndex'

const READY_STATUS = {
  ready: true,
  modelId: 'local-hash-v1',
  fileCount: 1,
  chunkCount: 3,
  lastIndexedAt: '2026-01-01T00:00:00.000Z'
}

const EMPTY_STATUS = {
  ready: false,
  modelId: '',
  fileCount: 0,
  chunkCount: 0,
  lastIndexedAt: null
}

describe('ready codebase_search skips the global index slot', () => {
  let dir: string | undefined
  let storageRoot: string | undefined
  let inFlightSearches = 0
  let releaseSearches!: () => void
  let searchGate!: Promise<void>

  beforeEach(() => {
    inFlightSearches = 0
    searchGate = new Promise<void>((resolve) => {
      releaseSearches = resolve
    })
    canUseIndexSearchUtilityMock.mockReturnValue(true)
    searchCodeMock.mockReset()
    searchCodeMock.mockImplementation(async () => {
      inFlightSearches++
      await searchGate
      return { hits: [], status: READY_STATUS }
    })
    storageRoot = mkdtempSync(join(tmpdir(), 'vyotiq-search-queue-storage-'))
    setWorkspaceIndexStorageRootOverrideForTests(storageRoot)
  })

  afterEach(() => {
    releaseSearches?.()
    resetIndexJobQueueForTests()
    clearWorkspaceIndexSyncTimers()
    if (dir) {
      disposeWorkspaceIndexes(dir)
      disposeCodeIndexWorkspace(dir)
      closeCodeIndex(dir)
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* windows sqlite */
      }
      dir = undefined
    }
    setWorkspaceIndexStorageRootOverrideForTests(null)
    if (storageRoot) {
      try {
        rmSync(storageRoot, { recursive: true, force: true })
      } catch {
        /* windows sqlite */
      }
      storageRoot = undefined
    }
    vi.restoreAllMocks()
  })

  function touchIndexDb(workspaceRoot: string): void {
    const store = CodeIndexStore.open(workspaceRoot, DEFAULT_EMBED_DIM)
    store.close()
  }

  async function holdWarmJob(): Promise<{
    release: () => void
    promise: Promise<unknown>
    preempt: AbortSignal | null
  }> {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const startedP = new Promise<void>((resolve) => {
      started = resolve
    })
    const promise = enqueueIndexJob({
      priority: 'warm',
      run: async () => {
        started()
        const preempt = activeIndexJobPreemptSignal()
        await Promise.race([
          gate,
          new Promise<void>((resolve) => {
            preempt?.addEventListener('abort', () => resolve(), { once: true })
          })
        ])
      }
    })
    await startedP
    return { release, promise, preempt: activeIndexJobPreemptSignal() }
  }

  async function expectPreemptedInteractive(preempt: AbortSignal | null): Promise<void> {
    await vi.waitFor(() => {
      expect(preempt?.aborted).toBe(true)
    })
  }

  it('runs two ready searches without taking the interactive slot while warm is held', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-search-queue-ready-'))
    touchIndexDb(dir)
    const warm = await holdWarmJob()
    const workspaceIndex = await import('@main/agent/workspaceIndex')
    const warmSpy = vi.spyOn(workspaceIndex, 'warmWorkspaceIndexes')

    const a = runCodebaseSearch(dir, 'alphaHelper', { preferOllama: false })
    const b = runCodebaseSearch(dir, 'betaHelper', { preferOllama: false })

    await vi.waitFor(() => {
      expect(inFlightSearches).toBe(2)
    })
    expect(indexJobQueuePendingInteractiveCountForTests()).toBe(0)
    expect(indexJobQueueActivePriorityForTests()).toBe('warm')
    expect(warm.preempt?.aborted).not.toBe(true)

    releaseSearches()
    await expect(a).resolves.toMatchObject({ status: READY_STATUS, queryModelId: 'local-hash-v1' })
    await expect(b).resolves.toMatchObject({ status: READY_STATUS, queryModelId: 'local-hash-v1' })
    await vi.waitFor(() => {
      expect(warmSpy).toHaveBeenCalledWith(dir)
    })
    expect(indexJobQueuePendingInteractiveCountForTests()).toBe(0)

    warm.release()
    await warm.promise
    warmSpy.mockRestore()
  })

  it('refresh:true still enqueues and preempts in-flight warm', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-search-queue-refresh-'))
    touchIndexDb(dir)
    const warm = await holdWarmJob()

    const pending = runCodebaseSearch(dir, 'alphaHelper', { preferOllama: false, refresh: true })
    await expectPreemptedInteractive(warm.preempt)

    releaseSearches()
    await pending
    await warm.promise
  })

  it('missing DB still takes the interactive slot', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-search-queue-missing-'))
    const warm = await holdWarmJob()

    const pending = runCodebaseSearch(dir, 'alphaHelper', { preferOllama: false })
    await expectPreemptedInteractive(warm.preempt)

    releaseSearches()
    await pending
    await warm.promise
  })

  it('empty not-ready store falls back to the interactive slot', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-search-queue-empty-'))
    touchIndexDb(dir)
    searchCodeMock.mockImplementation(async () => {
      inFlightSearches++
      if (inFlightSearches === 1) return { hits: [], status: EMPTY_STATUS }
      await searchGate
      return { hits: [], status: READY_STATUS }
    })
    const warm = await holdWarmJob()

    const pending = runCodebaseSearch(dir, 'alphaHelper', { preferOllama: false })
    await vi.waitFor(() => {
      expect(inFlightSearches).toBeGreaterThan(0)
    })
    await expectPreemptedInteractive(warm.preempt)

    releaseSearches()
    await pending
    await warm.promise
  })

  it('utility search failure falls back to the queued path', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-search-queue-locked-'))
    touchIndexDb(dir)
    searchCodeMock.mockImplementation(async () => {
      inFlightSearches++
      if (inFlightSearches === 1) throw new Error('database is locked')
      await searchGate
      return { hits: [], status: READY_STATUS }
    })
    const warm = await holdWarmJob()

    const pending = runCodebaseSearch(dir, 'alphaHelper', { preferOllama: false })
    await expectPreemptedInteractive(warm.preempt)

    releaseSearches()
    await pending
    await warm.promise
  })
})
