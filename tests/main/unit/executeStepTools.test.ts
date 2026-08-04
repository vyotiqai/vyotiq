import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AgentEvent } from '@shared/ipc'

const executeTool = vi.hoisted(() => vi.fn())

vi.mock('@main/agent/tools', () => ({
  executeTool: (...args: unknown[]) => executeTool(...args)
}))

import { executeStepToolCalls } from '@main/agent/executeStepTools'

type TestCtx = Parameters<typeof executeStepToolCalls>[1]

function makeCtx(
  signal: AbortSignal,
  runSignal?: AbortSignal
) {
  const events: AgentEvent[] = []
  const messages: unknown[] = []
  return {
    ctx: {
      runId: 'run-1',
      runDir: '/tmp/run',
      workspace: '/tmp/ws',
      signal,
      runSignal,
      appendMessage: (msg: unknown) => messages.push(msg),
      appendEvent: (ev: AgentEvent) => events.push(ev)
    } as unknown as TestCtx,
    events,
    messages
  }
}

function combinedSignal(runSignal: AbortSignal, softSignal: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([runSignal, softSignal])
  }
  return runSignal
}

describe('executeStepToolCalls', () => {
  beforeEach(() => {
    executeTool.mockReset()
  })

  it('preserves tool result order for parallel read-only calls', async () => {
    executeTool.mockImplementation(async (name: string) => {
      return { ok: true, summary: name, content: `body:${name}` }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    const outcome = await executeStepToolCalls(
      [
        { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'c2', name: 'read', arguments: '{"path":"b.ts"}' },
        { id: 'c3', name: 'search', arguments: '{"query":"foo"}' }
      ],
      ctx
    )

    expect(outcome.messages.map((m) => m.toolCallId)).toEqual(['c1', 'c2', 'c3'])
    expect(outcome.messages.map((m) => m.content)).toEqual(['body:read', 'body:read', 'body:search'])
    expect(outcome.stepToolsOk).toBe(true)
  })

  it('runs mutating tools after read-only batches in call order', async () => {
    const order: string[] = []
    executeTool.mockImplementation(async (name: string) => {
      order.push(name)
      return { ok: true, summary: name, content: name }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    await executeStepToolCalls(
      [
        { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'c2', name: 'edit', arguments: '{"path":"a.ts","contents":"x"}' },
        { id: 'c3', name: 'read', arguments: '{"path":"b.ts"}' }
      ],
      ctx
    )

    expect(order).toEqual(['read', 'edit', 'read'])
  })

  it('marks soft-aborted in-flight tools Interrupted while run cancel stays Cancelled', async () => {
    const runAc = new AbortController()
    const softAc = new AbortController()
    const signal = combinedSignal(runAc.signal, softAc.signal)

    executeTool.mockImplementation(async (_name, _args, _ws, toolSignal) => {
      while (!toolSignal.aborted) {
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new DOMException('Aborted', 'AbortError')
    })

    const { ctx } = makeCtx(signal, runAc.signal)
    const work = executeStepToolCalls(
      [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }],
      ctx
    )
    softAc.abort()
    const outcome = await work

    expect(outcome.stepToolsOk).toBe(false)
    expect(outcome.messages[0]?.content).toBe('Interrupted')
    expect(outcome.messages[0]?.toolCallId).toBe('c1')
  })

  it('marks run-cancelled tools as Cancelled when runSignal aborts', async () => {
    const runAc = new AbortController()
    const softAc = new AbortController()
    const signal = combinedSignal(runAc.signal, softAc.signal)

    executeTool.mockImplementation(async (_name, _args, _ws, toolSignal) => {
      while (!toolSignal.aborted) {
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new DOMException('Aborted', 'AbortError')
    })

    const { ctx } = makeCtx(signal, runAc.signal)
    const work = executeStepToolCalls(
      [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }],
      ctx
    )
    runAc.abort()
    const outcome = await work

    expect(outcome.stepToolsOk).toBe(false)
    expect(outcome.messages[0]?.content).toBe('Cancelled')
  })

  it('marks pending parallel read tools cancelled when aborted mid-batch', async () => {
    const ac = new AbortController()
    let started = 0
    executeTool.mockImplementation(async () => {
      started += 1
      if (started === 1) {
        ac.abort()
        await new Promise((r) => setTimeout(r, 20))
      }
      return { ok: true, summary: 'file', content: 'ok' }
    })

    const { ctx } = makeCtx(ac.signal)
    const outcome = await executeStepToolCalls(
      [
        { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'c2', name: 'read', arguments: '{"path":"b.ts"}' },
        { id: 'c3', name: 'read', arguments: '{"path":"c.ts"}' }
      ],
      ctx
    )

    expect(outcome.messages.map((m) => m.toolCallId)).toEqual(['c1', 'c2', 'c3'])
    // At least one tool never started or was interrupted after abort.
    const cancelled = outcome.messages.filter((m) => m.content === 'Cancelled')
    expect(cancelled.length).toBeGreaterThanOrEqual(1)
  })

  it('preserves completed parallel successes after abort and cancels only unfinished tools', async () => {
    const ac = new AbortController()
    let started = 0
    executeTool.mockImplementation(async () => {
      started += 1
      if (started === 1) {
        // Finish successfully before abort is observed by the other worker.
        await new Promise((r) => setTimeout(r, 5))
        return { ok: true, summary: 'early', content: 'completed-ok' }
      }
      ac.abort()
      await new Promise((r) => setTimeout(r, 30))
      return { ok: true, summary: 'late', content: 'also-finished' }
    })

    const { ctx, events } = makeCtx(ac.signal)
    const outcome = await executeStepToolCalls(
      [
        { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'c2', name: 'read', arguments: '{"path":"b.ts"}' }
      ],
      ctx
    )

    // Settled ToolOutcomes are kept (including late finishes that returned ok).
    expect(outcome.messages.every((m) => m.content === 'Cancelled')).toBe(false)
    expect(outcome.messages.some((m) => m.content === 'completed-ok' || m.content === 'also-finished')).toBe(
      true
    )
    // No duplicate tool_start for the same toolCallId.
    const starts = events.filter((e) => e.type === 'tool_start')
    const startIds = starts.map((e) => (e.type === 'tool_start' ? e.toolCallId : ''))
    expect(startIds.length).toBe(new Set(startIds).size)
  })

  it('does not re-emit tool_start when synthesizing abort for never-started parallel tools', async () => {
    const ac = new AbortController()
    let releaseFirst!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    executeTool.mockImplementation(async (_name, _args, _ws, toolSignal: AbortSignal) => {
      releaseFirst()
      while (!toolSignal.aborted) {
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new DOMException('Aborted', 'AbortError')
    })

    const { ctx, events } = makeCtx(ac.signal)
    // Two workers for three tools → one call never starts after abort.
    ctx.maxParallelReadTools = 2
    const work = executeStepToolCalls(
      [
        { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'c2', name: 'read', arguments: '{"path":"b.ts"}' },
        { id: 'c3', name: 'read', arguments: '{"path":"c.ts"}' }
      ],
      ctx
    )
    await firstStarted
    ac.abort()
    const outcome = await work

    expect(outcome.messages.map((m) => m.toolCallId)).toEqual(['c1', 'c2', 'c3'])
    expect(outcome.messages.some((m) => m.content === 'Cancelled')).toBe(true)
    const startsById = new Map<string, number>()
    for (const ev of events) {
      if (ev.type !== 'tool_start') continue
      startsById.set(ev.toolCallId, (startsById.get(ev.toolCallId) ?? 0) + 1)
    }
    expect(startsById.size).toBe(3)
    for (const count of startsById.values()) {
      expect(count).toBe(1)
    }
  })

  it('does not inject recipe text on repeated tool failures', async () => {
    executeTool.mockResolvedValue({
      ok: false,
      summary: 'core/build.gradle.kts',
      content: 'File not found: core/build.gradle.kts',
      failureLogged: true
    })

    const { ctx } = makeCtx(new AbortController().signal)
    const call = { id: 'c1', name: 'read', arguments: '{"path":"core/build.gradle.kts"}' }

    await executeStepToolCalls([call], ctx)
    const second = await executeStepToolCalls([call], ctx)

    expect(second.messages[0]?.content).toMatch(/File not found/)
    expect(String(second.messages[0]?.content)).not.toMatch(/Repeated failure|stop guessing/i)
  })

  it('feeds a denied approval back as a tool failure without running the tool', async () => {
    executeTool.mockResolvedValue({ ok: true, summary: 'edit', content: 'wrote' })

    const { ctx } = makeCtx(new AbortController().signal)
    ctx.approval = {
      authorize: async () => ({ allowed: false, reason: 'The user denied permission to run edit.' })
    }
    const outcome = await executeStepToolCalls(
      [{ id: 'c1', name: 'edit', arguments: '{"path":"a.ts","contents":"x"}' }],
      ctx
    )

    expect(executeTool).not.toHaveBeenCalled()
    expect(outcome.stepToolsOk).toBe(false)
    expect(outcome.messages[0]?.content).toMatch(/denied permission/)
    expect(outcome.messages[0]?.ok).toBe(false)
  })

  it('emits tool_start live and persists ok on tool messages', async () => {
    const live: AgentEvent[] = []
    executeTool.mockResolvedValue({ ok: false, summary: 'file', content: 'permission denied' })

    const { ctx, events } = makeCtx(new AbortController().signal)
    ctx.emitLiveEvent = (ev) => live.push(ev)
    const outcome = await executeStepToolCalls(
      [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }],
      ctx
    )

    expect(live.some((ev) => ev.type === 'tool_start' && ev.toolCallId === 'c1')).toBe(true)
    expect(live.some((ev) => ev.type === 'tool_result' && ev.toolCallId === 'c1')).toBe(true)
    expect(events.some((ev) => ev.type === 'tool_start' && ev.toolCallId === 'c1')).toBe(true)
    expect(outcome.messages[0]?.ok).toBe(false)
  })

  it('persists full tool output before emitting the live result', async () => {
    const order: string[] = []
    executeTool.mockResolvedValue({ ok: true, summary: 'big', content: 'full output' })
    const { ctx } = makeCtx(new AbortController().signal)
    ctx.appendMessage = async () => {
      await Promise.resolve()
      order.push('persisted')
    }
    ctx.emitLiveEvent = (event) => {
      if (event.type === 'tool_result') order.push('emitted')
    }

    await executeStepToolCalls(
      [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }],
      ctx
    )

    expect(order).toEqual(['persisted', 'emitted'])
  })

  it('stops later serial tools when appendMessage rejects (persist failure)', async () => {
    const ran: string[] = []
    executeTool.mockImplementation(async (name: string) => {
      ran.push(name)
      return { ok: true, summary: name, content: name }
    })
    const { ctx } = makeCtx(new AbortController().signal)
    let appends = 0
    ctx.appendMessage = async () => {
      appends++
      if (appends === 1) throw new Error('disk full')
    }

    await expect(
      executeStepToolCalls(
        [
          { id: 'c1', name: 'edit', arguments: '{"path":"a.ts","contents":"x"}' },
          { id: 'c2', name: 'edit', arguments: '{"path":"b.ts","contents":"y"}' }
        ],
        ctx
      )
    ).rejects.toThrow('disk full')

    expect(ran).toEqual(['edit'])
    expect(appends).toBe(1)
  })





  it('runs read-only tools serially when maxParallelReadTools is 1', async () => {
    const order: string[] = []
    executeTool.mockImplementation(async (name: string) => {
      order.push(name)
      await new Promise((r) => setTimeout(r, 5))
      return { ok: true, summary: name, content: name }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    ctx.maxParallelReadTools = 1
    await executeStepToolCalls(
      [
        { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'c2', name: 'read', arguments: '{"path":"b.ts"}' }
      ],
      ctx
    )

    expect(order).toEqual(['read', 'read'])
  })

  it('keeps parallel reads when an approval gate is present', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    let authorizeCalls = 0

    executeTool.mockImplementation(async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 15))
      concurrent -= 1
      return { ok: true, summary: 'file', content: 'ok' }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    ctx.approval = {
      authorize: async () => {
        authorizeCalls += 1
        return { allowed: true }
      }
    }

    await executeStepToolCalls(
      [
        { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'c2', name: 'read', arguments: '{"path":"b.ts"}' },
        { id: 'c3', name: 'read', arguments: '{"path":"c.ts"}' }
      ],
      ctx
    )

    // Approval gates each tool; read-only batches still run in parallel.
    expect(authorizeCalls).toBe(3)
    expect(maxConcurrent).toBeGreaterThan(1)
  })

  it('serializes gated web_fetch / web_search when an approval gate is present', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    let authorizeOverlapping = 0
    let authorizeInFlight = 0

    executeTool.mockImplementation(async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 20))
      concurrent -= 1
      return { ok: true, summary: 'ok', content: 'body' }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    ctx.approval = {
      authorize: async () => {
        authorizeInFlight += 1
        authorizeOverlapping = Math.max(authorizeOverlapping, authorizeInFlight)
        await new Promise((r) => setTimeout(r, 15))
        authorizeInFlight -= 1
        return { allowed: true }
      }
    }

    await executeStepToolCalls(
      [
        { id: 'f1', name: 'web_fetch', arguments: '{"url":"https://example.com/a"}' },
        { id: 'f2', name: 'web_fetch', arguments: '{"url":"https://example.com/b"}' },
        { id: 's1', name: 'web_search', arguments: '{"query":"vyotiq"}' }
      ],
      ctx
    )

    expect(authorizeOverlapping).toBe(1)
    expect(maxConcurrent).toBe(1)
  })

  it('emits tool_result live for each parallel tool as it finishes', async () => {
    const live: AgentEvent[] = []
    const finished: string[] = []

    executeTool.mockImplementation(async (_name: string, args: string) => {
      const path = JSON.parse(args).path as string
      if (path === 'b.ts') await new Promise((r) => setTimeout(r, 40))
      else await new Promise((r) => setTimeout(r, 5))
      finished.push(path)
      return { ok: true, summary: path, content: `body:${path}` }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    ctx.emitLiveEvent = (ev) => {
      if (ev.type === 'tool_result') live.push(ev)
    }

    await executeStepToolCalls(
      [
        { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'c2', name: 'read', arguments: '{"path":"b.ts"}' }
      ],
      ctx
    )

    expect(live.map((ev) => (ev.type === 'tool_result' ? ev.toolCallId : ''))).toEqual(['c1', 'c2'])
    expect(finished.indexOf('a.ts')).toBeLessThan(finished.indexOf('b.ts'))
  })

  it('soft-warns when editing an existing file never inspected in knownPaths', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-known-paths-'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), ' const x = 1\n', 'utf8')

    executeTool.mockResolvedValue({ ok: true, summary: 'edited', content: 'ok' })

    const { ctx } = makeCtx(new AbortController().signal)
    ctx.workspace = dir
    ctx.knownPaths = new Set()
    ctx.diagnosticsCommand = 'echo diagnostics'

    const outcome = await executeStepToolCalls(
      [{ id: 'c1', name: 'edit', arguments: '{"path":"src/a.ts","contents":"x"}' }],
      ctx
    )

    expect(outcome.messages[0]?.content).toContain(
      'Soft warning: edited existing file(s) without a prior read/grep/glob inspect: src/a.ts'
    )
    expect(outcome.messages[0]?.content).toContain('mutated file(s) without calling diagnostics')
  })

  it('soft-warns on file mutation without diagnostics in the same step', async () => {
    executeTool.mockResolvedValue({ ok: true, summary: 'edited', content: 'ok' })
    const { ctx } = makeCtx(new AbortController().signal)
    ctx.diagnosticsCommand = 'echo diagnostics'
    const outcome = await executeStepToolCalls(
      [{ id: 'c1', name: 'str_replace', arguments: '{"path":"new.ts","old":"a","new":"b"}' }],
      ctx
    )
    expect(outcome.messages[0]?.content).toContain('mutated file(s) without calling diagnostics')
  })

  it('forwards runSignal into tool execution context for nested abort semantics', async () => {
    const runAc = new AbortController()
    const softAc = new AbortController()
    executeTool.mockResolvedValue({ ok: true, summary: 'ok', content: 'ok' })
    const { ctx } = makeCtx(combinedSignal(runAc.signal, softAc.signal), runAc.signal)
    await executeStepToolCalls(
      [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }],
      ctx
    )
    expect(executeTool.mock.calls[0]?.[4]).toMatchObject({ runSignal: runAc.signal })
  })

  it('soft-warns after delete clears prior inspect so recreate-edit is unread', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, unlinkSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-delete-known-'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'const x = 1\n', 'utf8')

    executeTool.mockImplementation(async (name: string) => {
      if (name === 'delete') {
        unlinkSync(join(dir, 'src', 'a.ts'))
        return { ok: true, summary: 'deleted', content: 'ok' }
      }
      return { ok: true, summary: name, content: 'ok' }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    ctx.workspace = dir
    ctx.knownPaths = new Set(['src/a.ts'])

    await executeStepToolCalls(
      [{ id: 'd1', name: 'delete', arguments: '{"path":"src/a.ts"}' }],
      ctx
    )
    expect(ctx.knownPaths.has('src/a.ts')).toBe(false)

    // File reappears (user/other tool) without a new inspect.
    writeFileSync(join(dir, 'src', 'a.ts'), 'const x = 2\n', 'utf8')

    const outcome = await executeStepToolCalls(
      [{ id: 'e1', name: 'edit', arguments: '{"path":"src/a.ts","contents":"x"}' }],
      ctx
    )
    expect(outcome.messages[0]?.content).toContain(
      'Soft warning: edited existing file(s) without a prior read/grep/glob inspect: src/a.ts'
    )
  })

  it('skips diagnostics soft-nudge when diagnostics is in the same step', async () => {
    executeTool.mockResolvedValue({ ok: true, summary: 'ok', content: 'ok' })
    const { ctx } = makeCtx(new AbortController().signal)
    const outcome = await executeStepToolCalls(
      [
        { id: 'c1', name: 'edit', arguments: '{"path":"a.ts","contents":"x"}' },
        { id: 'c2', name: 'diagnostics', arguments: '{}' }
      ],
      ctx
    )
    const editMsg = outcome.messages.find((m) => m.toolCallId === 'c1')
    expect(editMsg?.content).not.toContain('mutated file(s) without calling diagnostics')
  })
})
