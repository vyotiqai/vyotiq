import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildRunReceipt,
  writeRunReceipt,
  wroteFilesFromEvents,
  RUN_RECEIPT_FILENAME,
  RUN_RECEIPT_VERSION
} from '@main/agent/runReceipt'
import { RunReceiptSchema } from '@shared/ipc'
import type { ChatMessage, PersistedEvent, RunStatus } from '@shared/ipc'

describe('runReceipt', () => {
  it('aggregates tool stats, failures, unread edits, and diagnostics', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'r1', name: 'read', arguments: '{"path":"a.ts"}' },
          { id: 'e1', name: 'str_replace', arguments: '{"path":"b.ts"}' }
        ]
      },
      { role: 'tool', toolCallId: 'r1', toolName: 'read', ok: true, content: 'ok' },
      {
        role: 'tool',
        toolCallId: 'e1',
        toolName: 'str_replace',
        ok: false,
        content: 'ENOENT missing'
      },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'd1', name: 'diagnostics', arguments: '{"kind":"typecheck"}' }]
      },
      {
        role: 'tool',
        toolCallId: 'd1',
        toolName: 'diagnostics',
        ok: true,
        content: 'clean'
      },
      { role: 'assistant', content: 'All done — task complete.' }
    ]
    const events: PersistedEvent[] = [
      {
        at: '2026-07-30T00:00:00.000Z',
        event: {
          type: 'writes_checkpoint',
          runId: 'run-1',
          checkpointId: 'c1',
          files: [{ path: 'b.ts', action: 'modified', undoable: true }]
        }
      },
      {
        at: '2026-07-30T00:00:01.000Z',
        event: {
          type: 'step_usage',
          runId: 'run-1',
          step: 1,
          inputTokens: 100,
          outputTokens: 20
        }
      },
      {
        at: '2026-07-30T00:00:02.000Z',
        event: { type: 'compaction', runId: 'run-1', summary: 'folded' }
      },
      {
        at: '2026-07-30T00:00:03.000Z',
        event: {
          type: 'incomplete',
          runId: 'run-1',
          reason: 'truncated',
          message: 'cut off'
        }
      }
    ]
    const status: RunStatus = {
      status: 'error',
      step: 3,
      updatedAt: '2026-07-30T00:00:01.000Z',
      goal: 'Fix b.ts',
      mode: 'agent',
      error: 'boom'
    }
    const receipt = buildRunReceipt({
      runId: 'run-1',
      status,
      messages,
      events,
      contract: '## Goal\n\nFix\n\n## Done when\n\n- tests pass\n',
    })
    expect(receipt.version).toBe(RUN_RECEIPT_VERSION)
    expect(receipt.toolStats.totalCalls).toBe(3)
    expect(receipt.toolStats.failed).toBe(1)
    expect(receipt.toolStats.byName.str_replace?.failed).toBe(1)
    expect(receipt.failureClusters[0]?.key).toMatch(/str_replace/)
    expect(receipt.unreadEditPaths).toContain('b.ts')
    expect(receipt.unreadEditPaths).not.toContain('a.ts')
    expect(receipt.wroteFiles).toEqual(['b.ts'])
    expect(receipt.diagnostics).toEqual({ calls: 1, ok: 1, clean: 1 })
    expect(receipt.contractExcerpt).toMatch(/Done when/)
    expect(receipt.statusError).toBe('boom')
    expect(receipt.incomplete).toEqual({ reason: 'truncated', message: 'cut off' })
    expect(receipt.tokenUsage).toEqual({
      inputTokens: 100,
      billedInputTokens: 100,
      peakInputTokens: 100,
      outputTokens: 20
    })
    expect(receipt.compactionCount).toBe(1)
    expect(receipt.maxConsecutiveToolFailures).toBe(1)
    expect(RunReceiptSchema.parse(receipt).runId).toBe('run-1')
  })

  it('measures the longest consecutive failed-tool-call run', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'f1', name: 'edit', arguments: '{"path":"a.ts"}' },
          { id: 'f2', name: 'edit', arguments: '{"path":"b.ts"}' },
          { id: 'f3', name: 'edit', arguments: '{"path":"c.ts"}' },
          { id: 'r1', name: 'read', arguments: '{"path":"d.ts"}' }
        ]
      },
      { role: 'tool', toolCallId: 'f1', toolName: 'edit', ok: false, content: 'boom 1' },
      { role: 'tool', toolCallId: 'f2', toolName: 'edit', ok: false, content: 'boom 2' },
      { role: 'tool', toolCallId: 'f3', toolName: 'edit', ok: false, content: 'boom 3' },
      { role: 'tool', toolCallId: 'r1', toolName: 'read', ok: true, content: 'ok' }
    ]
    const receipt = buildRunReceipt({
      runId: 'streaks',
      status: { status: 'error', step: 2, updatedAt: new Date().toISOString() },
      messages,
      events: [],
      contract: ''
    })
    expect(receipt.toolStats.failed).toBe(3)
    expect(receipt.maxConsecutiveToolFailures).toBe(3)

    // No failures → field omitted entirely (additive optional).
    const clean = buildRunReceipt({
      runId: 'clean',
      status: { status: 'done', step: 1, updatedAt: new Date().toISOString() },
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'r2', name: 'read', arguments: '{"path":"a.ts"}' }]
        },
        { role: 'tool', toolCallId: 'r2', toolName: 'read', ok: true, content: 'ok' }
      ],
      events: [],
      contract: ''
    })
    expect(clean).not.toHaveProperty('maxConsecutiveToolFailures')
  })

  it('extracts wroteFiles from CheckpointFileEntry objects', () => {
    expect(
      wroteFilesFromEvents([
        {
          at: 't',
          event: {
            type: 'writes_checkpoint',
            files: [
              { path: 'src\\a.ts', action: 'created', undoable: true },
              { path: 'b.ts', action: 'modified', undoable: true }
            ]
          }
        }
      ])
    ).toEqual(['src/a.ts', 'b.ts'])
  })

  it('filters garbage paths from wroteFiles checkpoint entries', () => {
    expect(
      wroteFilesFromEvents([
        {
          at: 't',
          event: {
            type: 'writes_checkpoint',
            files: [
              { path: 'package.json', action: 'created', undoable: true },
              { path: 'Directory', action: 'created', undoable: true },
              { path: 'src/config,src/llm,src/memory', action: 'created', undoable: true },
              { path: '=', action: 'created', undoable: true },
              { path: 'f1.confidence)', action: 'modified', undoable: true },
              { path: 'src/utils/paths.js', action: 'created', undoable: true }
            ]
          }
        }
      ])
    ).toEqual(['package.json', 'src/utils/paths.js'])
  })

  it('keeps cumulative metrics but scopes outcome fields to the latest invocation', () => {
    const receipt = buildRunReceipt({
      runId: 'resumed',
      status: {
        status: 'done',
        step: 4,
        updatedAt: new Date().toISOString(),
        invokeId: 2
      },
      messages: [
        { role: 'assistant', content: 'Task complete.' },
        { role: 'user', content: 'continue' },
        { role: 'assistant', content: 'I found a remaining blocker.' }
      ],
      events: [
        {
          at: 'old',
          event: {
            type: 'incomplete',
            runId: 'resumed',
            invokeId: 1,
            reason: 'truncated',
            message: 'old turn'
          }
        },
        {
          at: 'new',
          event: {
            type: 'step_usage',
            runId: 'resumed',
            invokeId: 2,
            step: 4,
            inputTokens: 10,
            outputTokens: 2
          }
        }
      ],
      contract: '',
    })

    expect(receipt.incomplete).toBeUndefined()
    expect(receipt.tokenUsage).toEqual({
      inputTokens: 10,
      billedInputTokens: 10,
      peakInputTokens: 10,
      outputTokens: 2
    })
    expect(receipt.invokeId).toBe(2)
  })

  it('normalizes em/en dashes and mojibake in failureClusters', () => {
    const messages: ChatMessage[] = [
      {
        role: 'tool',
        toolCallId: 'e1',
        toolName: 'multi_edit',
        ok: false,
        content: 'aborted — no files'
      },
      {
        role: 'tool',
        toolCallId: 'e2',
        toolName: 'multi_edit',
        ok: false,
        content: 'aborted â€" no files'
      },
      {
        role: 'tool',
        toolCallId: 'e3',
        toolName: 'multi_edit',
        ok: false,
        content: 'aborted – no files'
      }
    ]
    const receipt = buildRunReceipt({
      runId: 'dash',
      status: {
        status: 'error',
        step: 1,
        updatedAt: new Date().toISOString(),
        invokeId: 3
      },
      messages,
      events: [],
      contract: ''
    })
    expect(receipt.invokeId).toBe(3)
    expect(receipt.failureClusters).toEqual([
      { key: 'multi_edit: aborted - no files', count: 3 }
    ])
  })

  it('treats concrete grep/glob as seen for unread edits', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'g1', name: 'grep', arguments: '{"pattern":"x","include":"seen.ts"}' },
          { id: 'e1', name: 'str_replace', arguments: '{"path":"seen.ts"}' },
          { id: 'e2', name: 'edit', arguments: '{"path":"other.ts"}' }
        ]
      },
      { role: 'tool', toolCallId: 'g1', toolName: 'grep', ok: true, content: 'match' },
      { role: 'tool', toolCallId: 'e1', toolName: 'str_replace', ok: true, content: 'updated' },
      { role: 'tool', toolCallId: 'e2', toolName: 'edit', ok: true, content: 'updated' }
    ]
    const receipt = buildRunReceipt({
      runId: 'r',
      status: { status: 'done', step: 1, updatedAt: new Date().toISOString() },
      messages,
      events: [],
      contract: '',
    })
    expect(receipt.unreadEditPaths).not.toContain('seen.ts')
    expect(receipt.unreadEditPaths).toContain('other.ts')
  })

  it('writes receipt.json atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-receipt-'))
    try {
      const receipt = buildRunReceipt({
        runId: 'r',
        status: {
          status: 'cancelled',
          step: 0,
          updatedAt: new Date().toISOString()
        },
        messages: [],
        events: [],
        contract: '',
      })
      writeRunReceipt(dir, receipt)
      const raw = JSON.parse(readFileSync(join(dir, RUN_RECEIPT_FILENAME), 'utf8'))
      expect(raw.runId).toBe('r')
      expect(raw.status).toBe('cancelled')
      expect(raw.version).toBe(RUN_RECEIPT_VERSION)
      expect(raw.compactionCount).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })



  it('keeps latest step inputTokens and sums outputTokens across steps', () => {
    const receipt = buildRunReceipt({
      runId: 'multi-step',
      status: { status: 'done', step: 2, updatedAt: new Date().toISOString() },
      messages: [{ role: 'assistant', content: 'done' }],
      events: [
        {
          at: 't1',
          event: {
            type: 'step_usage',
            runId: 'multi-step',
            step: 1,
            inputTokens: 1000,
            outputTokens: 50
          }
        },
        {
          at: 't2',
          event: {
            type: 'step_usage',
            runId: 'multi-step',
            step: 2,
            inputTokens: 1500,
            outputTokens: 30
          }
        }
      ],
      contract: ''
    })
    // Latest window size vs cumulative billed input across steps.
    expect(receipt.tokenUsage).toEqual({
      inputTokens: 1500,
      billedInputTokens: 2500,
      peakInputTokens: 1500,
      outputTokens: 80
    })
  })

  it('sums billed input across resume even when later events carry lower process-local billed totals', () => {
    const receipt = buildRunReceipt({
      runId: 'resume-bill',
      status: { status: 'done', step: 3, updatedAt: new Date().toISOString() },
      messages: [{ role: 'assistant', content: 'done' }],
      events: [
        {
          at: 't1',
          event: {
            type: 'step_usage',
            runId: 'resume-bill',
            step: 1,
            inputTokens: 1000,
            outputTokens: 10,
            billedInputTokens: 1000
          }
        },
        {
          at: 't2',
          event: {
            type: 'step_usage',
            runId: 'resume-bill',
            step: 2,
            inputTokens: 2000,
            outputTokens: 10,
            billedInputTokens: 3000
          }
        },
        // After resume, emitter restarts process-local billed at this step only.
        {
          at: 't3',
          event: {
            type: 'step_usage',
            runId: 'resume-bill',
            step: 3,
            inputTokens: 500,
            outputTokens: 5,
            billedInputTokens: 500
          }
        }
      ],
      contract: ''
    })
    expect(receipt.tokenUsage).toEqual({
      inputTokens: 500,
      billedInputTokens: 3500,
      peakInputTokens: 2000,
      outputTokens: 25
    })
  })
})
