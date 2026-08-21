import { describe, expect, it } from 'vitest'
import { mergeLiveInstanceRuns } from '@renderer/app/mergeLiveInstanceRuns'
import type { RunSummary } from '@shared/ipc'
import type { AgentInstanceUiState } from '@shared/utils/agentInstance'

describe('mergeLiveInstanceRuns', () => {
  const parentRunId = 'parent-1'

  it('updates status/goal for already-listed instances from live phase', () => {
    const listed: RunSummary[] = [
      {
        runId: 'child-1',
        status: 'running',
        updatedAt: '2026-01-01T00:00:00.000Z',
        goal: 'Old goal',
        parentRunId,
        inlineInstance: true
      }
    ]
    const live: Record<string, AgentInstanceUiState> = {
      'child-1': {
        instanceRunId: 'child-1',
        phase: 'done',
        goal: 'Audit-partition B (LLM client & config)'
      }
    }
    const merged = mergeLiveInstanceRuns(listed, live, parentRunId)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.status).toBe('done')
    expect(merged[0]?.goal).toBe('Audit-partition B (LLM client & config)')
  })

  it('adds live-only instances not yet on disk list', () => {
    const live: Record<string, AgentInstanceUiState> = {
      'child-2': {
        instanceRunId: 'child-2',
        phase: 'started',
        goal: 'Partition C',
        pathScope: ['src/cli/']
      }
    }
    const merged = mergeLiveInstanceRuns([], live, parentRunId)
    expect(merged).toEqual([
      expect.objectContaining({
        runId: 'child-2',
        status: 'running',
        goal: 'Partition C',
        parentRunId,
        inlineInstance: true,
        pathScope: ['src/cli/']
      })
    ])
  })
})
