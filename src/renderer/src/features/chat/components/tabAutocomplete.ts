import {
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type EditorState
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { isContextEcho } from '@shared/inlineCompleteSanitize'

const DEBOUNCE_MS = 300
const PREFIX_MAX = 4_000
const SUFFIX_MAX = 2_000
const CACHE_MAX = 16

/** React cursor/selection sync — must not cancel an in-flight complete or drop ghost. */
export const SELECT_SYNC_EVENT = 'select.sync'

export type InlineCompleteRequestFn = ((
  prefix: string,
  suffix: string
) => Promise<string>) & { abort?: () => void }

type Ghost = { text: string; pos: number }

const setGhostEffect = StateEffect.define<Ghost | null>()

class GhostTextWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }

  eq(other: GhostTextWidget): boolean {
    return other.text === this.text
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-tab-ghost'
    span.textContent = this.text
    span.setAttribute('aria-hidden', 'true')
    return span
  }

  ignoreEvent(): boolean {
    return true
  }
}

class GhostBlockWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }

  eq(other: GhostBlockWidget): boolean {
    return other.text === this.text
  }

  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-tab-ghost cm-tab-ghost-block'
    el.textContent = this.text
    el.setAttribute('aria-hidden', 'true')
    return el
  }

  ignoreEvent(): boolean {
    return true
  }
}

function ghostDecorations(state: EditorState, ghost: Ghost): DecorationSet {
  const lines = ghost.text.split('\n')
  const first = lines[0] ?? ''
  const rest = lines.slice(1).join('\n')
  const widgets = []
  if (first) {
    widgets.push(
      Decoration.widget({
        widget: new GhostTextWidget(first),
        side: 1
      }).range(ghost.pos)
    )
  }
  if (rest) {
    const line = state.doc.lineAt(ghost.pos)
    widgets.push(
      Decoration.widget({
        widget: new GhostBlockWidget(rest),
        block: true,
        side: 1
      }).range(line.to)
    )
  }
  return widgets.length > 0 ? Decoration.set(widgets, true) : Decoration.none
}

function identChar(ch: string | undefined): boolean {
  return ch != null && /[A-Za-z0-9_$]/.test(ch)
}

/** True when the caret sits inside a token, not at a boundary. */
export function inMidToken(prefix: string, suffix: string): boolean {
  return identChar(prefix[prefix.length - 1]) && identChar(suffix[0])
}

function shrinkGhost(value: Ghost, tr: Transaction): Ghost | null {
  const inserts: Array<{ from: number; text: string; replaced: boolean }> = []
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, text) => {
    inserts.push({ from: fromA, text: text.toString(), replaced: fromA !== toA })
  })
  const only = inserts.length === 1 ? inserts[0] : undefined
  if (!only || only.replaced || only.from !== value.pos) return null
  if (!value.text.startsWith(only.text)) return null
  const rest = value.text.slice(only.text.length)
  if (!rest) return null
  return { text: rest, pos: value.pos + only.text.length }
}

const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setGhostEffect)) return effect.value
    }
    if (!value) return null
    if (tr.docChanged) return shrinkGhost(value, tr)
    if (tr.selection && tr.selection.main.head !== value.pos) return null
    return value
  },
  provide: (field) =>
    EditorView.decorations.compute([field], (state) => {
      const ghost = state.field(field)
      if (!ghost) return Decoration.none
      return ghostDecorations(state, ghost)
    })
})

/** Visible ghost suggestion, or null. Exported for tests. */
export function ghostText(state: EditorState): string | null {
  return state.field(ghostField, false)?.text ?? null
}

export function clearTabGhost(view: EditorView): void {
  if (!view.state.field(ghostField, false)) return
  view.dispatch({ effects: setGhostEffect.of(null) })
}

function acceptGhost(view: EditorView): boolean {
  const ghost = view.state.field(ghostField, false)
  if (!ghost) return false
  view.dispatch({
    changes: { from: ghost.pos, insert: ghost.text },
    selection: { anchor: ghost.pos + ghost.text.length },
    effects: setGhostEffect.of(null),
    userEvent: 'input.complete'
  })
  return true
}

function insertTab(view: EditorView): boolean {
  if (view.state.readOnly) return false
  view.dispatch(view.state.replaceSelection('\t'))
  return true
}

function clearGhost(view: EditorView): boolean {
  if (!view.state.field(ghostField, false)) return false
  view.dispatch({ effects: setGhostEffect.of(null) })
  return true
}

function isReload(update: ViewUpdate): boolean {
  return update.transactions.some(
    (tr) => tr.annotation(Transaction.userEvent) === 'input.reload'
  )
}

function isSelectSync(update: ViewUpdate): boolean {
  return update.transactions.every(
    (tr) =>
      tr.annotation(Transaction.userEvent) === SELECT_SYNC_EVENT || !tr.selection
  )
}

function sliceWindow(
  state: EditorState,
  pos: number
): { prefix: string; suffix: string } {
  const start = Math.max(0, pos - PREFIX_MAX)
  const end = Math.min(state.doc.length, pos + SUFFIX_MAX)
  return {
    prefix: state.doc.sliceString(start, pos),
    suffix: state.doc.sliceString(pos, end)
  }
}

function cacheKey(prefix: string, suffix: string): string {
  return `${prefix.length}:${suffix.length}:${prefix}\0${suffix}`
}

function readCache(cache: Map<string, string>, key: string): string | undefined {
  const hit = cache.get(key)
  if (hit == null) return undefined
  cache.delete(key)
  cache.set(key, hit)
  return hit
}

function writeCache(cache: Map<string, string>, key: string, text: string): void {
  if (!text) return
  if (cache.has(key)) cache.delete(key)
  cache.set(key, text)
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest != null) cache.delete(oldest)
  }
}

function applyGhost(view: EditorView, text: string, pos: number): void {
  if (!view.dom.isConnected) return
  if (view.state.selection.main.head !== pos) return
  const already = view.state.doc.sliceString(pos, pos + text.length)
  if (already === text) return
  const { prefix, suffix } = sliceWindow(view.state, pos)
  if (isContextEcho(text, prefix, suffix)) return
  view.dispatch({
    effects: setGhostEffect.of({ text, pos })
  })
}

/**
 * Ghost-text Tab complete. Tab accepts when a suggestion is showing, otherwise
 * inserts a tab. Esc dismisses. `getRequest` returning undefined disables fetches.
 */
export function tabAutocomplete(getRequest: () => InlineCompleteRequestFn | undefined) {
  let generation = 0
  let timer: number | null = null
  let scheduledPos = -1
  const cache = new Map<string, string>()

  const clearTimer = (): void => {
    if (timer != null) {
      window.clearTimeout(timer)
      timer = null
    }
  }

  const abortRequest = (): void => {
    getRequest()?.abort?.()
  }

  const schedule = (view: EditorView): void => {
    clearTimer()
    abortRequest()
    if (view.state.readOnly || !getRequest()) {
      generation += 1
      return
    }
    const main = view.state.selection.main
    if (main.from !== main.to) return
    const pos = main.head
    const { prefix, suffix } = sliceWindow(view.state, pos)
    if (inMidToken(prefix, suffix)) {
      generation += 1
      scheduledPos = pos
      return
    }
    scheduledPos = pos
    const gen = ++generation
    const key = cacheKey(prefix, suffix)
    const cached = readCache(cache, key)
    if (cached) {
      queueMicrotask(() => {
        if (gen !== generation || !getRequest()) return
        applyGhost(view, cached, pos)
      })
      return
    }
    timer = window.setTimeout(() => {
      timer = null
      const current = getRequest()
      if (!current || gen !== generation) return
      if (view.composing) {
        schedule(view)
        return
      }
      const sel = view.state.selection.main
      if (sel.from !== sel.to || sel.head !== pos) return
      const windowed = sliceWindow(view.state, pos)
      if (inMidToken(windowed.prefix, windowed.suffix)) return
      void current(windowed.prefix, windowed.suffix)
        .then((text) => {
          if (!text || gen !== generation) return
          if (!getRequest()) return
          if (view.state.selection.main.head !== pos) return
          writeCache(cache, cacheKey(windowed.prefix, windowed.suffix), text)
          applyGhost(view, text, pos)
        })
        .catch(() => undefined)
    }, DEBOUNCE_MS)
  }

  return [
    ghostField,
    Prec.highest(
      keymap.of([
        {
          key: 'Tab',
          run: (view) => acceptGhost(view) || insertTab(view)
        },
        { key: 'Escape', run: clearGhost }
      ])
    ),
    EditorView.updateListener.of((update) => {
      if (isReload(update)) {
        generation += 1
        scheduledPos = -1
        clearTimer()
        abortRequest()
        return
      }
      if (update.view.composing) {
        generation += 1
        clearTimer()
        abortRequest()
        return
      }
      if (update.docChanged) {
        const ghost = update.view.state.field(ghostField, false)
        if (ghost) {
          generation += 1
          scheduledPos = ghost.pos
          clearTimer()
          abortRequest()
          return
        }
        schedule(update.view)
        return
      }
      if (update.selectionSet) {
        const main = update.view.state.selection.main
        if (main.empty && main.head === scheduledPos) return
        if (isSelectSync(update) && main.empty) return
        if (!main.empty) {
          generation += 1
          scheduledPos = -1
          clearTimer()
          abortRequest()
          return
        }
        schedule(update.view)
      }
    }),
    EditorView.domEventHandlers({
      blur: (_event, view) => {
        generation += 1
        scheduledPos = -1
        clearTimer()
        abortRequest()
        if (view.state.field(ghostField, false)) {
          view.dispatch({ effects: setGhostEffect.of(null) })
        }
        return false
      },
      compositionend: (_event, view) => {
        schedule(view)
        return false
      }
    }),
    ViewPlugin.define(() => ({
      destroy() {
        generation += 1
        clearTimer()
        abortRequest()
      }
    }))
  ]
}
