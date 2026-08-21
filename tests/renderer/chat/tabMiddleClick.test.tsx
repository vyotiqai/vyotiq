/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import {
  AGENT_DOCK_TAB,
  DockTabBar,
  type DockTabItem
} from '@renderer/features/chat/components/DockTabBar'
import { AgentSessionBar } from '@renderer/features/chat/components/AgentSessionBar'
import { TerminalSessionBar } from '@renderer/features/chat/components/TerminalSessionBar'
import type { PtySessionInfo } from '@shared/ipc'

afterEach(() => {
  cleanup()
})

const terminalTab: DockTabItem = { id: 'terminal', label: 'Terminal', icon: 'terminal' }

function tabShell(name: string): HTMLElement {
  const tab = screen.getByRole('tab', { name })
  const shell = tab.parentElement
  if (!(shell instanceof HTMLElement)) throw new Error(`tab shell missing for ${name}`)
  return shell
}

function auxClick(el: HTMLElement, button: number): void {
  el.dispatchEvent(
    new MouseEvent('auxclick', { button, bubbles: true, cancelable: true })
  )
}

describe('middle-click tab close', () => {
  it('closes a closable dock panel tab on auxclick button 1', () => {
    const onCloseTab = vi.fn()
    render(
      <DockTabBar
        active="agent"
        tabs={[AGENT_DOCK_TAB, terminalTab]}
        onSelect={() => {}}
        onCloseTab={onCloseTab}
        onOpenPanel={() => {}}
      />
    )
    auxClick(tabShell('Terminal'), 1)
    expect(onCloseTab).toHaveBeenCalledWith('terminal')
  })

  it('never closes the Agent dock tab and ignores non-middle buttons', () => {
    const onCloseTab = vi.fn()
    render(
      <DockTabBar
        active="agent"
        tabs={[AGENT_DOCK_TAB, terminalTab]}
        onSelect={() => {}}
        onCloseTab={onCloseTab}
        onOpenPanel={() => {}}
      />
    )
    auxClick(tabShell('Agent'), 1)
    expect(onCloseTab).not.toHaveBeenCalled()
    auxClick(tabShell('Terminal'), 0)
    expect(onCloseTab).not.toHaveBeenCalled()
  })

  it('swallows middle-button mousedown (autoscroll) on dock tabs', () => {
    render(
      <DockTabBar
        active="terminal"
        tabs={[terminalTab]}
        onSelect={() => {}}
        onCloseTab={() => {}}
        onOpenPanel={() => {}}
      />
    )
    const shell = tabShell('Terminal')
    const event = new MouseEvent('mousedown', { button: 1, bubbles: true, cancelable: true })
    shell.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('closes a closable agent session tab but not the new-chat tab', () => {
    const onClose = vi.fn()
    render(
      <AgentSessionBar
        sessions={[
          { id: 'run-1', title: 'Working chat', closable: true },
          { id: null, title: 'New chat', closable: false }
        ]}
        activeId="run-1"
        onSelect={() => {}}
        onClose={onClose}
        onCreate={() => {}}
      />
    )
    auxClick(tabShell('Working chat'), 1)
    expect(onClose).toHaveBeenCalledWith('run-1')
    auxClick(tabShell('New chat'), 1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('kills a terminal session tab on middle-click', () => {
    const onKill = vi.fn()
    const session: PtySessionInfo = {
      id: 'sess-1',
      title: 'cmd',
      cwd: '/ws',
      running: true,
      backend: 'pty'
    }
    render(
      <TerminalSessionBar
        sessions={[session]}
        activeId="sess-1"
        splitId={null}
        onSelect={() => {}}
        onKill={onKill}
        onCreate={() => {}}
        onToggleSplit={() => {}}
      />
    )
    auxClick(tabShell('cmd'), 1)
    expect(onKill).toHaveBeenCalledWith('sess-1')
  })
})

describe('agent session running indicator', () => {
  it('marks a running session tab with the pulsing status dot', () => {
    render(
      <AgentSessionBar
        sessions={[
          { id: 'run-1', title: 'Refactoring auth', closable: true, running: true },
          { id: 'run-2', title: 'Idle chat', closable: true },
          { id: null, title: 'New chat', closable: false }
        ]}
        activeId="run-1"
        onSelect={() => {}}
        onClose={() => {}}
        onCreate={() => {}}
      />
    )
    const runningTab = screen.getByRole('tab', { name: /refactoring auth/i })
    const dot = runningTab.querySelector('span.bg-fg')
    expect(dot?.className).toMatch(/motion-safe:animate-pulse/)
    expect(dot?.getAttribute('title')).toBe('Running')
    expect(dot?.textContent).toContain('Running')

    const idleTab = screen.getByRole('tab', { name: /idle chat/i })
    expect(idleTab.querySelector('span.bg-fg')).toBeNull()
    expect(screen.getByRole('tab', { name: /new chat/i }).querySelector('span.bg-fg')).toBeNull()
  })
})
