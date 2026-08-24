import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent
} from 'react'
import { fileIconUrl } from '@renderer/lib/fileIcons'
import { cn } from '@renderer/lib/ui/cn'
import { COMPOSER_TEXTAREA_MAX_CLASS } from '@renderer/lib/utils/layout'
import { filesFromDataTransfer } from './dataTransferFiles'
import {
  MENTION_END,
  MENTION_START,
  decodeMentionPayload,
  mentionLabel,
  mentionMarker,
  parseComposerDocument,
  serializeComposerDocument,
  type ComposerMention,
  type ComposerSegment
} from './mentionModel'

export type ComposerMentionInputHandle = {
  focus: () => void
  getSelectionStart: () => number
  setSelectionStart: (offset: number) => void
  el: HTMLDivElement | null
}

function encodeDataMention(mention: ComposerMention): string {
  return mentionMarker(mention).slice(MENTION_START.length, -MENTION_END.length)
}

function chipClassName(kind: ComposerMention['kind']): string {
  const accent = kind === 'slash' ? 'text-accent' : 'text-secondary'
  return [
    'mention-chip mx-0.5 inline-flex max-w-[12rem] items-center gap-1 align-baseline',
    'px-0.5 text-sm leading-none',
    accent,
    'select-none'
  ].join(' ')
}

function slashChipGlyph(slashKind: Extract<ComposerMention, { kind: 'slash' }>['slashKind']): string {
  switch (slashKind) {
    case 'skill':
      return '✦'
    case 'mcp':
      return '⬡'
    case 'builtin':
      return '/'
    case 'workspace':
      return '⌘'
    case 'rule':
      return '▤'
    default:
      return '/'
  }
}

function buildChipElement(mention: ComposerMention): HTMLSpanElement {
  const span = document.createElement('span')
  span.contentEditable = 'false'
  span.dataset.mention = encodeDataMention(mention)
  span.className = chipClassName(mention.kind)
  span.setAttribute('data-mention-kind', mention.kind)

  if (mention.kind === 'file' || mention.kind === 'docs') {
    const img = document.createElement('img')
    img.src = fileIconUrl(mention.path)
    img.alt = ''
    img.setAttribute('aria-hidden', 'true')
    img.width = 14
    img.height = 14
    img.draggable = false
    img.className = 'shrink-0 object-contain'
    span.appendChild(img)
  } else {
    const ico = document.createElement('span')
    ico.className = 'text-caption opacity-70'
    ico.textContent =
      mention.kind === 'branch'
        ? '⎇'
        : mention.kind === 'browser'
          ? '◎'
          : mention.kind === 'lints'
            ? '!'
            : mention.kind === 'rule'
              ? '▤'
              : mention.kind === 'slash'
                ? slashChipGlyph(mention.slashKind)
                : '◇'
    span.appendChild(ico)
  }

  const label = document.createElement('span')
  label.className = 'truncate'
  label.textContent = mentionLabel(mention)
  span.appendChild(label)
  return span
}

function segmentsFromDom(root: HTMLElement): ComposerSegment[] {
  const segments: ComposerSegment[] = []
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? ''
      if (value) segments.push({ type: 'text', value })
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    if (el.dataset.mention) {
      const mention = decodeMentionPayload(el.dataset.mention)
      if (mention) segments.push({ type: 'mention', mention })
      return
    }
    if (el.tagName === 'BR') {
      segments.push({ type: 'text', value: '\n' })
      return
    }
    for (const child of Array.from(node.childNodes)) walk(child)
    if ((el.tagName === 'DIV' || el.tagName === 'P') && el !== root) {
      const last = segments[segments.length - 1]
      if (!last || last.type !== 'text' || !last.value.endsWith('\n')) {
        segments.push({ type: 'text', value: '\n' })
      }
    }
  }
  for (const child of Array.from(root.childNodes)) walk(child)
  return segments.length ? segments : [{ type: 'text', value: '' }]
}

function serializeDom(root: HTMLElement): string {
  return serializeComposerDocument(segmentsFromDom(root))
}

function renderSegmentsInto(root: HTMLElement, value: string): void {
  root.replaceChildren()
  const segments = parseComposerDocument(value)
  for (const seg of segments) {
    if (seg.type === 'text') {
      if (!seg.value) continue
      const parts = seg.value.split('\n')
      parts.forEach((part, i) => {
        if (part) root.appendChild(document.createTextNode(part))
        if (i < parts.length - 1) root.appendChild(document.createElement('br'))
      })
    } else {
      root.appendChild(buildChipElement(seg.mention))
    }
  }
}

function caretSerializedOffset(root: HTMLElement): number {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return serializeDom(root).length
  const range = sel.getRangeAt(0)
  const pre = document.createRange()
  pre.selectNodeContents(root)
  pre.setEnd(range.startContainer, range.startOffset)
  const walkerRoot = document.createElement('div')
  walkerRoot.appendChild(pre.cloneContents())
  return serializeDom(walkerRoot).length
}

function setCaretSerializedOffset(root: HTMLElement, target: number): void {
  const sel = window.getSelection()
  if (!sel) return

  let remaining = Math.max(0, target)
  const placeAt = (node: Node, offset: number): void => {
    const range = document.createRange()
    range.setStart(node, offset)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }

  const walk = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.textContent ?? '').length
      if (remaining <= len) {
        placeAt(node, remaining)
        return true
      }
      remaining -= len
      return false
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return false
    const el = node as HTMLElement
    if (el.dataset.mention) {
      const decoded = decodeMentionPayload(el.dataset.mention)
      if (!decoded) return false
      const markerLen = mentionMarker(decoded).length
      if (remaining <= markerLen) {
        const parent = el.parentNode
        if (!parent) return true
        const idx = Array.from(parent.childNodes).indexOf(el)
        if (remaining < markerLen / 2) placeAt(parent, idx)
        else placeAt(parent, idx + 1)
        return true
      }
      remaining -= markerLen
      return false
    }
    if (el.tagName === 'BR') {
      if (remaining <= 1) {
        const parent = el.parentNode
        if (!parent) return true
        placeAt(parent, Array.from(parent.childNodes).indexOf(el) + 1)
        return true
      }
      remaining -= 1
      return false
    }
    for (const child of Array.from(node.childNodes)) {
      if (walk(child)) return true
    }
    return false
  }

  if (!walk(root)) {
    const range = document.createRange()
    range.selectNodeContents(root)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
  }
}

export const ComposerMentionInput = forwardRef<
  ComposerMentionInputHandle,
  {
    value: string
    onChange: (value: string) => void
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void
    onCaretChange?: (offset: number) => void
    placeholder?: string
    disabled?: boolean
    className?: string
    onPasteFiles?: (files: File[]) => void
    'aria-expanded'?: boolean
    'aria-controls'?: string
    'aria-autocomplete'?: 'list' | 'none' | 'inline' | 'both'
    'aria-activedescendant'?: string
    onFocus?: () => void
  }
>(function ComposerMentionInput(
  {
    value,
    onChange,
    onKeyDown,
    onCaretChange,
    placeholder,
    disabled,
    className,
    onPasteFiles,
    onFocus,
    'aria-expanded': ariaExpanded,
    'aria-controls': ariaControls,
    'aria-autocomplete': ariaAutocomplete,
    'aria-activedescendant': ariaActivedescendant
  },
  ref
) {
  const elRef = useRef<HTMLDivElement>(null)
  const lastValueRef = useRef(value)
  const composingRef = useRef(false)
  const [composing, setComposing] = useState(false)

  useImperativeHandle(ref, () => ({
    focus: () => elRef.current?.focus(),
    getSelectionStart: () => (elRef.current ? caretSerializedOffset(elRef.current) : 0),
    setSelectionStart: (offset: number) => {
      if (elRef.current) setCaretSerializedOffset(elRef.current, offset)
    },
    get el() {
      return elRef.current
    }
  }))

  useLayoutEffect(() => {
    const el = elRef.current
    if (!el) return
    if (value === lastValueRef.current) {
      if (!el.childNodes.length && value) {
        renderSegmentsInto(el, value)
      } else if (
        !value &&
        el.childNodes.length > 0 &&
        !composingRef.current
      ) {
        // Controlled value is empty but DOM still has nodes (orphan after desync).
        renderSegmentsInto(el, value)
      }
      return
    }
    const focused = document.activeElement === el
    const caret = focused ? caretSerializedOffset(el) : value.length
    renderSegmentsInto(el, value)
    lastValueRef.current = value
    if (focused) {
      // replaceChildren can drop focus/caret even when activeElement still looks set.
      el.focus()
      setCaretSerializedOffset(el, Math.min(caret, value.length))
    }
  }, [value])

  useEffect(() => {
    const el = elRef.current
    if (!el) return
    if (!el.childNodes.length && value) {
      renderSegmentsInto(el, value)
      lastValueRef.current = value
    }
  }, [value])

  const emitFromDom = useCallback((): void => {
    const el = elRef.current
    if (!el) return
    const next = serializeDom(el)
    lastValueRef.current = next
    onChange(next)
    onCaretChange?.(caretSerializedOffset(el))
  }, [onChange, onCaretChange])

  const syncCaret = useCallback((): void => {
    const el = elRef.current
    if (!el) return
    onCaretChange?.(caretSerializedOffset(el))
  }, [onCaretChange])

  const onInput = (_e: FormEvent<HTMLDivElement>): void => {
    if (composingRef.current) return
    emitFromDom()
  }

  const empty =
    !composing &&
    (!value ||
      parseComposerDocument(value).every((s) => s.type === 'text' && !s.value.trim()))

  return (
    <div className="relative min-w-0 w-full">
      {empty && placeholder ? (
        <div
          className="pointer-events-none absolute inset-0 flex items-center text-md leading-snug tracking-normal text-secondary"
          aria-hidden
          style={{ letterSpacing: 0, textRendering: 'auto' }}
        >
          {placeholder}
        </div>
      ) : null}
      {/* Combobox role + expanded state live on the focused editable element
          (ARIA 1.2): screen readers announce expansion only from the focused node. */}
      <div
        ref={elRef}
        role={disabled ? 'textbox' : 'combobox'}
        aria-expanded={disabled ? undefined : (ariaExpanded ?? false)}
        aria-controls={disabled ? undefined : ariaControls}
        aria-haspopup={disabled ? undefined : 'listbox'}
        aria-multiline="true"
        aria-label="Message"
        aria-keyshortcuts="Meta+L Control+L"
        aria-autocomplete={ariaAutocomplete}
        aria-activedescendant={ariaActivedescendant}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        contentEditable={disabled ? false : true}
        suppressContentEditableWarning
        className={cn(
          'min-h-7 min-w-0 w-full overflow-y-auto whitespace-pre-wrap break-words',
          COMPOSER_TEXTAREA_MAX_CLASS,
          'border-0 bg-transparent p-0 text-md leading-snug text-fg outline-none ring-0',
          'focus:ring-0 focus-visible:ring-0',
          disabled && 'opacity-[var(--vy-disabled-opacity)]',
          className
        )}
        onInput={onInput}
        onKeyDown={(e) => {
          onKeyDown(e)
          requestAnimationFrame(syncCaret)
        }}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        onFocus={() => {
          syncCaret()
          onFocus?.()
        }}
        onBlur={syncCaret}
        onCompositionStart={() => {
          composingRef.current = true
          setComposing(true)
        }}
        onCompositionEnd={() => {
          composingRef.current = false
          setComposing(false)
          emitFromDom()
        }}
        onPaste={(e) => {
          e.preventDefault()
          const files = filesFromDataTransfer(e.clipboardData)
          if (files.length) onPasteFiles?.(files)
          const text = e.clipboardData.getData('text/plain')
          if (text) document.execCommand('insertText', false, text)
        }}
      />
    </div>
  )
})
