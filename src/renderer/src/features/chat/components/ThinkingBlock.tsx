import { useEffect, useRef, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { MarkdownContent, cn } from '@renderer/lib/ui'
import { DISCLOSURE_ROW } from '@renderer/lib/utils/layout'
import { ExpandPanel } from '../toolUi/ExpandPanel'

/**
 * Cap the open thought body so long reasoning cannot dominate the transcript.
 * Scales with the viewport, clamped for short and tall windows.
 */
const THINKING_BODY_MAX =
  'max-h-[min(4.5rem,12vh)] sm:max-h-[min(5.5rem,14vh)] overflow-y-auto overscroll-contain'

/** Subtle but readable — dimmer than answer text-fg. */
const THINKING_INK =
  '!text-caption !leading-snug !text-tertiary [&_*]:!text-tertiary [&_a]:!underline [&_a]:!decoration-tertiary'

export function ThinkingBlock({
  content,
  streaming,
  expanded,
  onToggle
}: {
  content: string
  streaming?: boolean
  expanded?: boolean
  onToggle?: (next: boolean) => void
}) {
  // Cursor-style: open only while streaming so tools and the answer stay front
  // and center. Finished thought is a quiet one-line disclosure.
  const [override, setOverride] = useState<boolean | null>(null)
  const isExpanded = expanded ?? override ?? streaming === true
  const bodyRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!isExpanded || !streaming) return
    const el = bodyRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [content, isExpanded, streaming])

  const toggle = (): void => {
    const next = !isExpanded
    setOverride(next)
    onToggle?.(next)
  }

  return (
    <div className="w-full min-w-0">
      <button
        type="button"
        className={cn(DISCLOSURE_ROW, 'text-tertiary')}
        aria-expanded={isExpanded}
        aria-label={streaming ? 'Thinking' : 'Thought'}
        onClick={toggle}
      >
        {streaming ? (
          <span className="font-medium text-tertiary">Thinking</span>
        ) : (
          <span className="font-medium text-tertiary">Thought</span>
        )}
        <Icon
          name="chevronRight"
          size={14}
          className={cn(
            'shrink-0 text-tertiary/80 vy-transition',
            isExpanded && 'rotate-90'
          )}
        />
      </button>
      <ExpandPanel open={isExpanded}>
        <div
          ref={bodyRef}
          className={cn('mt-0.5 border-l border-border pl-3', THINKING_BODY_MAX)}
        >
          {streaming ? (
            <MarkdownContent content={content} streaming className={THINKING_INK} />
          ) : (
            <MarkdownContent content={content} streaming={false} className={THINKING_INK} />
          )}
        </div>
      </ExpandPanel>
    </div>
  )
}
