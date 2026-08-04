/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  matchShortcut,
  shouldDeferAppEscapeStop,
  shortcutLabel
} from '@renderer/lib/shortcuts'

afterEach(() => {
  document.body.innerHTML = ''
  // @ts-expect-error test cleanup
  delete window.vyotiq
})

function keyEvent(
  key: string,
  mods: {
    ctrlKey?: boolean
    metaKey?: boolean
    altKey?: boolean
    shiftKey?: boolean
  } = {}
): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, ...mods })
}

describe('matchShortcut', () => {
  it('matches mod chords with ctrl or meta and rejects alt/shift', () => {
    expect(matchShortcut(keyEvent('b', { ctrlKey: true }), 'sidebar')).toBe(true)
    expect(matchShortcut(keyEvent('B', { metaKey: true }), 'sidebar')).toBe(true)
    expect(matchShortcut(keyEvent('b', { ctrlKey: true, altKey: true }), 'sidebar')).toBe(
      false
    )
    expect(matchShortcut(keyEvent('b', { ctrlKey: true, shiftKey: true }), 'sidebar')).toBe(
      false
    )
    expect(matchShortcut(keyEvent('b'), 'sidebar')).toBe(false)
  })

  it('matches settings comma and plain Escape stop', () => {
    expect(matchShortcut(keyEvent(',', { ctrlKey: true }), 'settings')).toBe(true)
    expect(matchShortcut(keyEvent('Escape'), 'stop')).toBe(true)
    expect(matchShortcut(keyEvent('Escape', { ctrlKey: true }), 'stop')).toBe(false)
    expect(matchShortcut(keyEvent('Escape', { metaKey: true }), 'stop')).toBe(false)
    expect(matchShortcut(keyEvent('Escape', { altKey: true }), 'stop')).toBe(false)
  })

  it('matches panel find/refresh', () => {
    expect(matchShortcut(keyEvent('f', { ctrlKey: true }), 'find')).toBe(true)
    expect(matchShortcut(keyEvent('r', { metaKey: true }), 'refresh')).toBe(true)
    expect(matchShortcut(keyEvent('r', { ctrlKey: true, shiftKey: true }), 'refresh')).toBe(
      false
    )
  })
})

describe('shortcutLabel', () => {
  it('uses Ctrl+ on non-darwin', () => {
    // @ts-expect-error test bridge
    window.vyotiq = { platform: 'win32' }
    expect(shortcutLabel('search')).toBe('Ctrl+K')
    expect(shortcutLabel('newChat')).toBe('Ctrl+N')
    expect(shortcutLabel('settings')).toBe('Ctrl+,')
    expect(shortcutLabel('find')).toBe('Ctrl+F')
    expect(shortcutLabel('refresh')).toBe('Ctrl+R')
    expect(shortcutLabel('stop')).toBe('Esc')
  })

  it('uses ⌘ on darwin', () => {
    // @ts-expect-error test bridge
    window.vyotiq = { platform: 'darwin' }
    expect(shortcutLabel('search')).toBe('⌘K')
    expect(shortcutLabel('focusComposer')).toBe('⌘L')
    expect(shortcutLabel('settings')).toBe('⌘,')
  })
})

describe('shouldDeferAppEscapeStop', () => {
  it('defers for drawer, session query, menus, dialogs, and composer menus', () => {
    expect(shouldDeferAppEscapeStop({ drawerOpen: true })).toBe(true)
    expect(shouldDeferAppEscapeStop({ hasSessionQuery: true })).toBe(true)

    const menu = document.createElement('button')
    menu.setAttribute('aria-expanded', 'true')
    menu.setAttribute('aria-haspopup', 'menu')
    document.body.appendChild(menu)
    expect(shouldDeferAppEscapeStop()).toBe(true)
    menu.remove()

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    document.body.appendChild(dialog)
    expect(shouldDeferAppEscapeStop()).toBe(true)
    dialog.remove()

    const slash = document.createElement('div')
    slash.setAttribute('role', 'listbox')
    slash.setAttribute('aria-label', 'Slash commands')
    document.body.appendChild(slash)
    expect(shouldDeferAppEscapeStop()).toBe(true)
    slash.remove()
  })

  it('defers for sidebar inline confirm', () => {
    const confirm = document.createElement('div')
    confirm.setAttribute('data-inline-confirm', '')
    document.body.appendChild(confirm)
    expect(shouldDeferAppEscapeStop()).toBe(true)
  })

  it('defers for Mentions listbox', () => {
    const mentions = document.createElement('div')
    mentions.setAttribute('role', 'listbox')
    mentions.setAttribute('aria-label', 'Mentions')
    document.body.appendChild(mentions)
    expect(shouldDeferAppEscapeStop()).toBe(true)
  })

  it('defers when focus is inside inline cancel-edit composer', () => {
    const wrap = document.createElement('div')
    wrap.setAttribute('data-composer-inline', 'true')
    const input = document.createElement('div')
    input.tabIndex = 0
    wrap.appendChild(input)
    document.body.appendChild(wrap)
    input.focus()
    expect(document.activeElement).toBe(input)
    expect(shouldDeferAppEscapeStop()).toBe(true)
  })

  it('defers for focus-opened tooltip only', () => {
    const hoverTip = document.createElement('div')
    hoverTip.setAttribute('role', 'tooltip')
    hoverTip.setAttribute('data-opened-by', 'hover')
    hoverTip.textContent = 'Hover'
    document.body.appendChild(hoverTip)
    expect(shouldDeferAppEscapeStop()).toBe(false)
    hoverTip.remove()

    const focusTip = document.createElement('div')
    focusTip.setAttribute('role', 'tooltip')
    focusTip.setAttribute('data-opened-by', 'focus')
    focusTip.textContent = 'Focus'
    document.body.appendChild(focusTip)
    expect(shouldDeferAppEscapeStop()).toBe(true)
  })

  it('defers when find / PR title inputs are focused', () => {
    for (const label of ['Find in changes', 'Find in diff', 'PR title']) {
      const input = document.createElement('input')
      input.setAttribute('aria-label', label)
      document.body.appendChild(input)
      input.focus()
      expect(shouldDeferAppEscapeStop()).toBe(true)
      input.remove()
    }
  })

  it('does not defer when nothing is open', () => {
    expect(shouldDeferAppEscapeStop()).toBe(false)
  })
})
