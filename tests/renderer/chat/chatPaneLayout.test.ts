import { describe, expect, it } from 'vitest'
import {
  applyPaneDrop,
  closePane,
  createPaneId,
  insertPaneBeside,
  maxPaneCount,
  openRunInFocusedPane,
  removeSessionFromLayout,
  resolvePaneDropZone,
  sanitizePaneLayout,
  singlePaneLayout,
  syncSinglePaneSession
} from '@renderer/lib/chat/chatPaneLayout'

describe('chatPaneLayout', () => {
  it('computes max pane count from viewport width', () => {
    expect(maxPaneCount(1200)).toBe(3)
    expect(maxPaneCount(700)).toBe(1)
    expect(maxPaneCount(1200, 220)).toBe(2)
  })

  it('maps drop X into left/center/right thirds', () => {
    expect(resolvePaneDropZone(10, 300)).toBe('left')
    expect(resolvePaneDropZone(150, 300)).toBe('center')
    expect(resolvePaneDropZone(290, 300)).toBe('right')
    expect(resolvePaneDropZone(0, 0)).toBe('right')
  })

  it('inserts pane beside anchor without switching workspace context', () => {
    const base = singlePaneLayout('/ws-a', 'run-a', 'pane-a')
    const next = insertPaneBeside(
      base,
      'pane-a',
      'right',
      { workspacePath: '/ws-b', runId: 'run-b' },
      3
    )
    expect(next?.panes).toHaveLength(2)
    expect(next?.panes[1]?.workspacePath).toBe('/ws-b')
    expect(next?.focusedPaneId).toBe(next?.panes[1]?.paneId)
  })

  it('refuses split when at capacity', () => {
    const paneA = createPaneId()
    const paneB = createPaneId()
    const layout = {
      panes: [
        { paneId: paneA, workspacePath: '/a', runId: '1' },
        { paneId: paneB, workspacePath: '/b', runId: '2' }
      ],
      focusedPaneId: paneA,
      sizes: [0.5, 0.5]
    }
    const next = insertPaneBeside(
      layout,
      paneA,
      'right',
      { workspacePath: '/c', runId: '3' },
      2
    )
    expect(next).toBeNull()
  })

  it('replaces center drop target session', () => {
    const base = singlePaneLayout('/ws-a', 'run-a', 'pane-a')
    const next = applyPaneDrop(
      base,
      'pane-a',
      'center',
      { workspacePath: '/ws-b', runId: 'run-b' },
      3
    )
    expect(next?.panes[0]?.workspacePath).toBe('/ws-b')
    expect(next?.panes[0]?.runId).toBe('run-b')
  })

  it('center drop focuses existing pane instead of duplicating', () => {
    const paneA = createPaneId()
    const paneB = createPaneId()
    const layout = {
      panes: [
        { paneId: paneA, workspacePath: '/a', runId: '1' },
        { paneId: paneB, workspacePath: '/b', runId: '2' }
      ],
      focusedPaneId: paneA,
      sizes: [0.5, 0.5]
    }
    const next = applyPaneDrop(
      layout,
      paneA,
      'center',
      { workspacePath: '/b', runId: '2' },
      3
    )
    expect(next?.panes).toHaveLength(2)
    expect(next?.focusedPaneId).toBe(paneB)
    expect(next?.panes.filter((p) => p.runId === '2')).toHaveLength(1)
  })

  it('sanitize drops closed workspaces and clamps capacity', () => {
    const paneA = createPaneId()
    const paneB = createPaneId()
    const paneC = createPaneId()
    const layout = {
      panes: [
        { paneId: paneA, workspacePath: '/open', runId: '1' },
        { paneId: paneB, workspacePath: '/gone', runId: '2' },
        { paneId: paneC, workspacePath: '/open', runId: '3' }
      ],
      focusedPaneId: paneB,
      sizes: [1, 1, 1]
    }
    const next = sanitizePaneLayout(layout, ['/open'], 1)
    expect(next?.panes).toHaveLength(1)
    expect(next?.panes[0]?.runId).toBe('1')
    expect(next?.focusedPaneId).toBe(paneA)
  })

  it('removeSessionFromLayout closes matching panes', () => {
    const paneA = createPaneId()
    const paneB = createPaneId()
    const layout = {
      panes: [
        { paneId: paneA, workspacePath: '/a', runId: '1' },
        { paneId: paneB, workspacePath: '/a', runId: '2' }
      ],
      focusedPaneId: paneA,
      sizes: [0.5, 0.5]
    }
    const next = removeSessionFromLayout(layout, { workspacePath: '/a', runId: '1' })
    expect(next.panes).toHaveLength(1)
    expect(next.panes[0]?.runId).toBe('2')
  })

  it('closes pane and keeps one full-width layout', () => {
    const paneA = createPaneId()
    const paneB = createPaneId()
    const layout = {
      panes: [
        { paneId: paneA, workspacePath: '/a', runId: '1' },
        { paneId: paneB, workspacePath: '/b', runId: '2' }
      ],
      focusedPaneId: paneB,
      sizes: [0.5, 0.5]
    }
    const next = closePane(layout, paneB)
    expect(next.panes).toHaveLength(1)
    expect(next.panes[0]?.paneId).toBe(paneA)
  })

  it('syncs single-pane session on workspace switch', () => {
    const base = singlePaneLayout('/ws-a', 'run-a', 'pane-a')
    const next = syncSinglePaneSession(base, '/ws-b', 'run-b')
    expect(next.panes[0]?.workspacePath).toBe('/ws-b')
    expect(next.panes[0]?.runId).toBe('run-b')
  })

  it('focuses existing pane when opening duplicate session', () => {
    const paneA = createPaneId()
    const paneB = createPaneId()
    const layout = {
      panes: [
        { paneId: paneA, workspacePath: '/a', runId: '1' },
        { paneId: paneB, workspacePath: '/b', runId: '2' }
      ],
      focusedPaneId: paneA,
      sizes: [0.5, 0.5]
    }
    const next = openRunInFocusedPane(layout, { workspacePath: '/b', runId: '2' })
    expect(next.focusedPaneId).toBe(paneB)
    expect(next.panes).toHaveLength(2)
  })
})
