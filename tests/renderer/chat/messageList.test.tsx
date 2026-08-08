/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  estimateTranscriptRowSize,
  MessageList,
  transcriptRowsContentRevision
} from '@renderer/features/chat/components/MessageList'
import { buildTranscriptRows } from '@renderer/features/chat/utils/transcriptRows'
import { TOOL_BODY_CLAMP_PX, TOOL_GROUP_LIST_MAX_PX, TOOL_TERMINAL_VIEWPORT_MAX_PX } from '@renderer/lib/utils/layout'
import type { UiItem } from '@shared/transcript'

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    })
  })
  Element.prototype.scrollIntoView = () => {}
})

afterEach(() => {
  cleanup()
})

function toolGroup(groupKey: string, summaries: string[]): UiItem[] {
  return summaries.map((summary, i) => ({
    kind: 'tool' as const,
    id: `${groupKey}-${i}`,
    tool: {
      id: `${groupKey}-${i}`,
      name: 'read',
      summary,
      status: 'done' as const
    },
    groupTiming: i === 0 ? { startedAt: 1_000, endedAt: 2_000 } : undefined
  }))
}

describe('MessageList', () => {
  it('keeps the narration between tool batches on the page', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'a1', role: 'assistant', content: 'First look.' },
      ...toolGroup('alpha', ['alpha-one.ts', 'alpha-two.ts']),
      { kind: 'message', id: 'a2', role: 'assistant', content: 'Next batch.' },
      ...toolGroup('beta', ['beta-only.ts'])
    ]

    render(<MessageList items={items} />)

    expect(screen.getByText('First look.')).toBeTruthy()
    expect(screen.getByText('Next batch.')).toBeTruthy()
    // Narration separates the two batches, so each keeps its own header.
    expect(screen.getAllByText('Read')).toHaveLength(2)
    expect(screen.getByText('2 files')).toBeTruthy()
    expect(screen.getByText('beta-only.ts')).toBeTruthy()

    const body = document.querySelector('[data-transcript-scroll]')?.textContent ?? ''
    expect(body.indexOf('First look.')).toBeLessThan(body.indexOf('Next batch.'))
  })

  it('streams assistant text and reasoning inline, mid tool loop', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'audit it' },
      ...toolGroup('alpha', ['alpha-one.ts']),
      {
        kind: 'message',
        id: 'a2',
        role: 'assistant',
        content: 'Now checking how the router is wired.',
        thinking: 'The table is built up front.',
        thinkingStreaming: true,
        streaming: true
      }
    ]

    render(<MessageList items={items} />)

    expect(screen.getByText('Now checking how the router is wired.')).toBeTruthy()
    expect(screen.getByText('The table is built up front.')).toBeTruthy()
  })

  it('does not re-apply scroll restore when restoreScrollTop updates without a new token', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'msg-1', role: 'assistant', content: 'Hello', streaming: true }
    ]

    const scrollTopSpy = vi.fn()
    const { rerender } = render(
      <MessageList
        items={items}
        restoreScrollTop={100}
        scrollRestoreToken={1}
        onScrollTopChange={scrollTopSpy}
      />
    )

    const container = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    expect(container).toBeTruthy()

    const initialScrollTop = container.scrollTop
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => initialScrollTop,
      set: vi.fn()
    })

    rerender(
      <MessageList
        items={[
          { kind: 'message', id: 'msg-1', role: 'assistant', content: 'Hello world', streaming: true }
        ]}
        restoreScrollTop={250}
        scrollRestoreToken={1}
        onScrollTopChange={scrollTopSpy}
      />
    )

    expect(container.scrollTop).toBe(initialScrollTop)
  })

  it('renders every row in a long transcript', () => {
    const items: UiItem[] = Array.from({ length: 45 }, (_, i) => ({
      kind: 'message' as const,
      id: `m-${i}`,
      role: 'assistant' as const,
      content: `Line ${i}`
    }))

    render(<MessageList items={items} />)

    expect(screen.getByText('Line 0')).toBeTruthy()
    expect(screen.getByText('Line 44')).toBeTruthy()
    expect(document.querySelectorAll('[data-index]')).toHaveLength(0)
  })

  it('groups consecutive tool rows in long threads', () => {
    const pad = Array.from({ length: 40 }, (_, i) => ({
      kind: 'message' as const,
      id: `pad-${i}`,
      role: 'assistant' as const,
      content: `pad ${i}`
    }))
    const tools = toolGroup('tail', ['one.ts', 'two.ts', 'three.ts'])
    const items: UiItem[] = [...pad, ...tools]

    render(<MessageList items={items} />)

    expect(screen.getByText('3 files')).toBeTruthy()
    expect(screen.getByText('pad 0')).toBeTruthy()
  })

  it('uses instant tail follow while streaming', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    const items: UiItem[] = [
      { kind: 'message', id: 'msg-1', role: 'assistant', content: 'Streaming', streaming: true }
    ]

    render(<MessageList items={items} />)

    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('follows the tail via scrollHeight so dock padding stays clear', async () => {
    class ResizeObserverStub {
      private readonly cb: ResizeObserverCallback
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb
      }
      observe(): void {
        this.cb([], this as unknown as ResizeObserver)
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)

    const items: UiItem[] = Array.from({ length: 12 }, (_, i) => ({
      kind: 'message' as const,
      id: `m-${i}`,
      role: 'assistant' as const,
      content: `Line ${i}`
    }))

    const { rerender } = render(
      <MessageList items={items} />
    )
    const scroll = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    expect(scroll).toBeTruthy()

    let scrollTop = 0
    const scrollTopSet = vi.fn((value: number) => {
      scrollTop = value
    })
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 4000 })
    Object.defineProperty(scroll, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: scrollTopSet
    })

    // Far enough from the end that pin slack (dockReserve) does not early-return.
    scrollTop = 3300

    const next = [
      ...items,
      {
        kind: 'message' as const,
        id: 'm-tail',
        role: 'assistant' as const,
        content: 'new line'
      }
    ]
    rerender(<MessageList items={next} />)

    await vi.waitFor(() => {
      expect(scrollTopSet).toHaveBeenCalled()
    })
    expect(scrollTopSet).toHaveBeenCalledWith(4000)

    vi.unstubAllGlobals()
  })

  it('renders the live turn summary inline after work in the transcript', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'go' },
      {
        kind: 'tool',
        id: 't1',
        tool: { id: 't1', name: 'read', summary: 'file.ts', status: 'running' }
      }
    ]
    render(<MessageList items={items} running pendingRun />)

    expect(document.querySelector('[data-turn-summary-chrome]')).toBeNull()
    const scroll = document.querySelector('[data-transcript-scroll]')
    expect(scroll).toBeTruthy()
    const working = screen.getByRole('button', { name: /Collapse turn work/i })
    expect(scroll!.contains(working)).toBe(true)

    const column = scroll!.querySelector('[data-chat-column]')
    const order = [...(column?.querySelectorAll('[data-chat-column] > div') ?? [])]
    // Live expanded: activity/card chrome is hidden; TurnSummary owns the phase.
    // Flow children: user prompt, then turn summary (collapse control).
    expect(order.length).toBe(2)
    expect(order[1]?.querySelector('button[aria-label*="Collapse turn work"]')).toBeTruthy()
    expect(screen.queryByText('file.ts')).toBeNull()
  })

  it('follows content growth on the same message id while streaming and pinned', async () => {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)

    const { rerender } = render(
      <MessageList
        items={[
          {
            kind: 'message',
            id: 'msg-stream',
            role: 'assistant',
            content: 'Hello',
            streaming: true
          }
        ]}
        running
      />
    )
    const scroll = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    let scrollTop = 0
    const scrollTopSet = vi.fn((value: number) => {
      scrollTop = value
    })
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(scroll, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: scrollTopSet
    })
    // Within former dock slack — must still follow so tokens do not sit under the composer.
    scrollTop = 2000 - 400 - 50
    scrollTopSet.mockClear()

    rerender(
      <MessageList
        items={[
          {
            kind: 'message',
            id: 'msg-stream',
            role: 'assistant',
            content: 'Hello world, still streaming more tokens here',
            streaming: true
          }
        ]}
        running
      />
    )

    await vi.waitFor(() => {
      expect(scrollTopSet).toHaveBeenCalledWith(2000)
    })

    vi.unstubAllGlobals()
  })

  it('does not follow content growth when the user has scrolled away', async () => {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)

    const { rerender } = render(
      <MessageList
        items={[
          {
            kind: 'message',
            id: 'msg-stream',
            role: 'assistant',
            content: 'Hello',
            streaming: true
          }
        ]}
        running
      />
    )
    const scroll = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    let scrollTop = 0
    const scrollTopSet = vi.fn((value: number) => {
      scrollTop = value
    })
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(scroll, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: scrollTopSet
    })
    scrollTop = 200
    fireEvent.scroll(scroll)
    scrollTopSet.mockClear()

    rerender(
      <MessageList
        items={[
          {
            kind: 'message',
            id: 'msg-stream',
            role: 'assistant',
            content: 'Hello world grew a lot without pin',
            streaming: true
          }
        ]}
        running
      />
    )

    await new Promise((r) => setTimeout(r, 40))
    expect(scrollTopSet).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
  })

  it('follows the tail when content grows while pinned', async () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'msg-1', role: 'assistant', content: 'Hello' }
    ]
    const { rerender } = render(<MessageList items={items} />)
    const scroll = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    let scrollTop = 0
    const scrollTopSet = vi.fn((value: number) => {
      scrollTop = value
    })
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 900 })
    Object.defineProperty(scroll, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: scrollTopSet
    })
    scrollTop = 500

    const next: UiItem[] = [
      { kind: 'message', id: 'msg-1', role: 'assistant', content: 'Hello with more content' }
    ]
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1200 })
    rerender(<MessageList items={next} />)

    await vi.waitFor(() => {
      expect(scrollTopSet).toHaveBeenCalledWith(1200)
    })
  })

  it('keeps chat column as a direct child of the scrollport', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'hello' }
    ]
    render(<MessageList items={items} />)
    const scroll = document.querySelector('[data-transcript-scroll]')
    const column = document.querySelector('[data-chat-column]')
    expect(scroll).toBeTruthy()
    expect(column).toBeTruthy()
    expect(column?.parentElement).toBe(scroll)
    expect(scroll?.className.includes('flex-col')).toBe(false)
  })

  it('grows total size estimates when streaming text content grows', () => {
    const short = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: 'Hello',
        streaming: true,
        thinking: 'plan',
        thinkingStreaming: true
      }
    ])
    const tall = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: 'Hello\n\n'.repeat(40) + 'more',
        streaming: true,
        thinking: 'plan that grew a lot with more reasoning tokens',
        thinkingStreaming: true
      },
      {
        kind: 'tool',
        id: 't1',
        tool: {
          id: 't1',
          name: 'read',
          summary: 'dir',
          status: 'done',
          content: 'file list\n'.repeat(20)
        }
      }
    ])

    const shortRev = transcriptRowsContentRevision(short)
    const tallRev = transcriptRowsContentRevision(tall)
    expect(shortRev).not.toBe(tallRev)

    const shortEstimate = short.reduce((sum, row) => sum + estimateTranscriptRowSize(row), 0)
    const tallEstimate = tall.reduce((sum, row) => sum + estimateTranscriptRowSize(row), 0)
    expect(tallEstimate).toBeGreaterThan(shortEstimate)

    // Simulated measured layout: starts must be non-overlapping.
    let cursor = 0
    for (const row of tall) {
      const size = estimateTranscriptRowSize(row)
      const start = cursor
      cursor += size
      expect(cursor).toBeGreaterThan(start)
    }
  })

  it('uses document flow for short transcripts so rows cannot absolute-overlap', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: 'Hello! I am Agent V. Welcome to the workspace.'
      },
      {
        kind: 'message',
        id: 'u2',
        role: 'user',
        content: 'Launch multiple parallel agents for:- audit everything'
      }
    ]
    render(<MessageList items={items} />)
    expect(document.querySelectorAll('[data-index]')).toHaveLength(0)
    const column = document.querySelector('[data-chat-column]')
    expect(column?.className.includes('relative')).toBe(false)
    expect(screen.getByText(/Hello! I am Agent V/)).toBeTruthy()
    expect(screen.getByText(/Launch multiple parallel agents/)).toBeTruthy()
  })

  it('keeps document flow while the agent is running even for long transcripts', () => {
    const items: UiItem[] = Array.from({ length: 180 }, (_, i) => ({
      kind: 'message' as const,
      id: `m-${i}`,
      role: 'assistant' as const,
      content: `Line ${i}`
    }))
    render(<MessageList items={items} running />)
    expect(document.querySelectorAll('[data-index]')).toHaveLength(0)
    expect(screen.getByText('Line 0')).toBeTruthy()
    expect(screen.getByText('Line 179')).toBeTruthy()
  })

  it('virtualizes older rows within a single long live turn', () => {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)

    const originalGbc = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
      if (this.hasAttribute?.('data-transcript-scroll')) {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          bottom: 800,
          right: 720,
          width: 720,
          height: 800,
          toJSON() {
            return {}
          }
        } as DOMRect
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 40,
        right: 720,
        width: 720,
        height: 40,
        toJSON() {
          return {}
        }
      } as DOMRect
    }

    const prevVitest = process.env.VITEST
    process.env.VITEST = ''

    const items: UiItem[] = [
      { kind: 'message', id: 'u0', role: 'user', content: 'start' },
      ...Array.from({ length: 179 }, (_, i) => ({
        kind: 'message' as const,
        id: `m-${i}`,
        role: 'assistant' as const,
        content: `Line ${i}`
      }))
    ]
    render(<MessageList items={items} running />)
    const flow = document.querySelector('[data-live-turn-flow]')
    expect(flow).toBeTruthy()
    expect(screen.queryByText('Line 0')).toBeNull()
    expect(screen.queryByText('Line 50')).toBeNull()
    const flowRows = flow?.querySelectorAll(':scope > div').length ?? 0
    expect(flowRows).toBeGreaterThan(30)
    expect(flowRows).toBeLessThanOrEqual(45)

    process.env.VITEST = prevVitest
    Element.prototype.getBoundingClientRect = originalGbc
    vi.unstubAllGlobals()
  })

  it('stays in document flow after a live run ends (no cold virtualizer gaps)', () => {
    const items: UiItem[] = Array.from({ length: 180 }, (_, i) => ({
      kind: 'message' as const,
      id: `m-${i}`,
      role: 'assistant' as const,
      content: `Line ${i}`
    }))
    const { rerender } = render(<MessageList items={items} running />)
    expect(document.querySelectorAll('[data-index]')).toHaveLength(0)
    rerender(<MessageList items={items} running={false} />)
    expect(document.querySelectorAll('[data-index]')).toHaveLength(0)
    expect(screen.getByText('Line 179')).toBeTruthy()
  })

  it('estimates collapsed activity/thinking near disclosure height, not inflated slots', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: '',
        thinking: 'enough thinking characters here',
        thinkingStreaming: false
      },
      {
        kind: 'tool',
        id: 't1',
        tool: { id: 't1', name: 'read', summary: 'a.ts', status: 'done' }
      }
    ])
    const thinking = rows.find((r) => r.kind === 'thinking')
    const activity = rows.find((r) => r.kind === 'activity')
    expect(estimateTranscriptRowSize(thinking)).toBeLessThanOrEqual(52)
    expect(estimateTranscriptRowSize(activity)).toBeLessThanOrEqual(56)
  })

  it('estimates settled todo_write as expanded via familyDefaultExpanded', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'tool',
        id: 'todo1',
        tool: {
          id: 'todo1',
          name: 'todo_write',
          summary: 'Plan',
          status: 'done',
          argsPreview: JSON.stringify({
            todos: [{ id: '1', content: 'Ship', status: 'completed' }]
          })
        }
      }
    ])
    const activity = rows.find((r) => r.kind === 'activity')
    expect(estimateTranscriptRowSize(activity)).toBe(56 + TOOL_BODY_CLAMP_PX)
  })

  it('estimates live multi-tool activity at the capped list viewport', () => {
    const multi = buildTranscriptRows([
      {
        kind: 'tool',
        id: 't1',
        tool: { id: 't1', name: 'read', summary: 'a.ts', status: 'done' }
      },
      {
        kind: 'tool',
        id: 't2',
        tool: { id: 't2', name: 'read', summary: 'b.ts', status: 'running' }
      }
    ])
    const activity = multi.find((r) => r.kind === 'activity')
    expect(estimateTranscriptRowSize(activity)).toBe(48 + TOOL_GROUP_LIST_MAX_PX)

    const collapsedStale = buildTranscriptRows([
      {
        kind: 'tool',
        id: 't1',
        tool: { id: 't1', name: 'read', summary: 'a.ts', status: 'done' },
        toolExpanded: true
      },
      {
        kind: 'tool',
        id: 't2',
        tool: { id: 't2', name: 'read', summary: 'b.ts', status: 'done' }
      }
    ])
    const stale = collapsedStale.find((r) => r.kind === 'activity')
    expect(estimateTranscriptRowSize(stale)).toBe(48)

    const loneLive = buildTranscriptRows([
      {
        kind: 'tool',
        id: 't1',
        tool: { id: 't1', name: 'read', summary: 'a.ts', status: 'running' }
      }
    ])
    const single = loneLive.find((r) => r.kind === 'activity')
    // Running file reads stay compact (path row only) — no body height.
    expect(estimateTranscriptRowSize(single)).toBe(48)
  })

  it('estimates running terminal cards as fixed-height viewports', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'tool',
        id: 't1',
        tool: {
          id: 't1',
          name: 'terminal',
          summary: 'pnpm test',
          status: 'running',
          argsPreview: '{"command":"pnpm test"}',
          presentation: 'prominent'
        }
      }
    ])
    const card = rows.find((r) => r.kind === 'card')
    expect(card?.kind).toBe('card')
    expect(estimateTranscriptRowSize(card)).toBe(56 + TOOL_TERMINAL_VIEWPORT_MAX_PX)
  })

  it('estimates collapsed terminal cards with the clamp peek height', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'tool',
        id: 't1',
        tool: {
          id: 't1',
          name: 'terminal',
          summary: 'pnpm test',
          status: 'done',
          argsPreview: '{"command":"pnpm test"}',
          content: 'cwd: /ws\n\nok\nexit_code: 0',
          presentation: 'prominent'
        },
        toolExpanded: false
      }
    ])
    const card = rows.find((r) => r.kind === 'card')
    expect(estimateTranscriptRowSize(card)).toBe(
      56 + Math.min(TOOL_BODY_CLAMP_PX, TOOL_TERMINAL_VIEWPORT_MAX_PX)
    )
  })

  it('estimates long assistant text tall enough to avoid virtual overlap', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: 'paragraph\n'.repeat(80)
      }
    ])
    const text = rows.find((r) => r.kind === 'text')
    expect(estimateTranscriptRowSize(text)).toBeGreaterThan(280)
  })

  it('lays out virtual rows without overlapping translateY slots when measured', () => {
    class ResizeObserverStub {
      private readonly cb: ResizeObserverCallback
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb
      }
      observe(target: Element): void {
        const height = target.hasAttribute('data-transcript-scroll') ? 800 : 120
        const width = 720
        this.cb(
          [
            {
              target,
              contentRect: {
                x: 0,
                y: 0,
                top: 0,
                left: 0,
                bottom: height,
                right: width,
                width,
                height,
                toJSON() {
                  return {}
                }
              },
              borderBoxSize: [{ blockSize: height, inlineSize: width }],
              contentBoxSize: [{ blockSize: height, inlineSize: width }],
              devicePixelContentBoxSize: [{ blockSize: height, inlineSize: width }]
            } as ResizeObserverEntry
          ],
          this as unknown as ResizeObserver
        )
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)

    const originalGbc = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
      if (this.hasAttribute?.('data-transcript-scroll')) {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          bottom: 800,
          right: 720,
          width: 720,
          height: 800,
          toJSON() {
            return {}
          }
        } as DOMRect
      }
      const indexAttr = this.getAttribute?.('data-index')
      if (indexAttr != null) {
        const h = 90 + Number(indexAttr) * 55
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          bottom: h,
          right: 720,
          width: 720,
          height: h,
          toJSON() {
            return {}
          }
        } as DOMRect
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 40,
        right: 720,
        width: 720,
        height: 40,
        toJSON() {
          return {}
        }
      } as DOMRect
    }

    // Force the virtualizer path (not Vitest full-DOM fallback) with enough idle rows.
    const prevVitest = process.env.VITEST
    process.env.VITEST = ''

    const items: UiItem[] = Array.from({ length: 180 }, (_, i) => ({
      kind: 'message' as const,
      id: `pad-${i}`,
      role: 'assistant' as const,
      content: `Pad line ${i}`
    }))

    render(<MessageList items={items} />)

    const indexed = [...document.querySelectorAll('[data-index]')] as HTMLElement[]
    expect(indexed.length).toBeGreaterThanOrEqual(2)

    const starts = indexed
      .map((el) => Number(/translateY\(([-\d.]+)px\)/.exec(el.style.transform)?.[1] ?? NaN))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)
    expect(starts.length).toBe(indexed.length)
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]!).toBeGreaterThan(starts[i - 1]!)
    }

    const column = document.querySelector('[data-chat-column]') as HTMLElement
    const totalSize = Number.parseFloat(column.style.height)
    expect(totalSize).toBeGreaterThan(starts[starts.length - 1]!)

    process.env.VITEST = prevVitest
    Element.prototype.getBoundingClientRect = originalGbc
    vi.unstubAllGlobals()
  })

  it('clicking a user prompt calls onBeginEditUserMessage with its message index', () => {
    const onBegin = vi.fn()
    const items: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'first prompt' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'ok' },
      { kind: 'message', id: 'user-2', role: 'user', content: 'second prompt' }
    ]

    render(<MessageList items={items} onBeginEditUserMessage={onBegin} />)

    const editable = screen.getAllByLabelText('Edit message')
    expect(editable).toHaveLength(2)
    fireEvent.click(editable[1]!)
    expect(onBegin).toHaveBeenCalledWith(2)
  })

  it('shows Revert back only when later transcript content exists', () => {
    const onRevert = vi.fn()
    const items: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'first prompt' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'ok' },
      { kind: 'message', id: 'user-2', role: 'user', content: 'second prompt' },
      { kind: 'message', id: 'a2', role: 'assistant', content: 'ok2' }
    ]

    const { rerender } = render(
      <MessageList
        items={items}
        messageCount={4}
        onRevertUserMessage={onRevert}
      />
    )

    expect(screen.getAllByLabelText('Revert back')).toHaveLength(2)

    rerender(
      <MessageList
        items={[{ kind: 'message', id: 'user-0', role: 'user', content: 'solo prompt' }]}
        messageCount={1}
        onRevertUserMessage={onRevert}
      />
    )
    expect(screen.queryByLabelText('Revert back')).toBeNull()

    rerender(
      <MessageList
        items={items}
        messageCount={4}
        running
        onRevertUserMessage={onRevert}
      />
    )
    expect(screen.queryByLabelText('Revert back')).toBeNull()
  })

  it('clicking Revert back calls onRevertUserMessage with its message index', () => {
    const onRevert = vi.fn()
    const items: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'first prompt' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'ok' }
    ]

    render(
      <MessageList items={items} messageCount={2} onRevertUserMessage={onRevert} />
    )

    fireEvent.click(screen.getByLabelText('Revert back'))
    expect(onRevert).toHaveBeenCalledWith(0)
  })

  it('replaces the user bubble with editComposer while editing', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'original prompt' }
    ]

    render(
      <MessageList
        items={items}
        editingUserMessageIndex={0}
        editComposer={<div data-testid="inline-composer">editing…</div>}
        onBeginEditUserMessage={() => {}}
      />
    )

    expect(screen.getByTestId('inline-composer')).toBeTruthy()
    expect(screen.queryByText('original prompt')).toBeNull()
    expect(screen.queryByLabelText('Edit message')).toBeNull()
  })

  it('marks editable user prompts with a click-to-edit title', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'hover me' }
    ]

    render(<MessageList items={items} onBeginEditUserMessage={() => {}} />)

    const editBtn = screen.getByLabelText('Edit message')
    const bubble = editBtn.closest('[aria-label="User message"]')
    expect(bubble).toBeTruthy()
    expect(bubble?.className).toContain('group/prompt')
  })
})
