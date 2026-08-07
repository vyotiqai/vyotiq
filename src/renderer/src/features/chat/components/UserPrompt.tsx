import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { FileChip, ImageChip, MarkdownContent, balanceIncompleteMarkdown, cn } from '@renderer/lib/ui'
import { slashChipFromContent } from '@shared/slashCommands'
import { TOOL_BODY_CLAMP_PX, USER_PROMPT_SURFACE } from '@renderer/lib/utils/layout'
import type { UserItem } from '../utils/transcriptRows'
import { SlashChip } from './SlashChip'

export function UserPrompt({
  item,
  onImageClick,
  editing = false,
  editComposer,
  onBeginEdit,
  onRevert,
  canRevert = false,
}: {
  item: UserItem
  onImageClick: (url: string, label: string) => void
  editing?: boolean
  editComposer?: ReactNode
  onBeginEdit?: () => void
  onRevert?: () => void
  canRevert?: boolean
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const slashChip = useMemo(
    () => (item.content ? slashChipFromContent(item.content) : null),
    [item.content]
  )

  const content = useMemo(() => {
    if (!item.content) return ''
    if (slashChip) {
      return slashChip.userRequest
        ? balanceIncompleteMarkdown(slashChip.userRequest)
        : ''
    }
    return balanceIncompleteMarkdown(item.content)
  }, [item.content, slashChip])

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    setOverflows(el.scrollHeight > TOOL_BODY_CLAMP_PX + 8)
  }, [content, slashChip])

  if (editing && editComposer) {
    return <div className="w-full">{editComposer}</div>
  }

  const clamped = overflows && !expanded
  const editable = Boolean(onBeginEdit)
  const revertable = Boolean(onRevert && canRevert)
  const hasBody = Boolean(content) || Boolean(slashChip)

  return (
    <div
      className={cn(
        USER_PROMPT_SURFACE,
        'relative',
        (editable || revertable) &&
          cn(
            'group/prompt vy-transition',
            editable && 'cursor-text hover:border-border-strong hover:bg-surface/30'
          )
      )}
      aria-label={editable ? 'User message' : undefined}
      title={editable ? 'Click to edit' : undefined}
      onClick={
        editable
          ? (e) => {
              const target = e.target as HTMLElement
              if (target.closest('button, a, [data-no-prompt-edit]')) return
              onBeginEdit?.()
            }
          : undefined
      }
    >
      {editable ? (
        <button
          type="button"
          className={cn(
            'absolute top-1 z-[1] inline-grid size-6 place-items-center rounded-md',
            revertable ? 'right-8' : 'right-1',
            'text-muted hover:bg-surface hover:text-fg',
            'opacity-0 vy-transition',
            'group-hover/prompt:opacity-100 group-focus-within/prompt:opacity-100',
            'focus-visible:opacity-100 focus-visible:vy-focus-ring'
          )}
          aria-label="Edit message"
          data-no-prompt-edit
          onClick={(e) => {
            e.stopPropagation()
            onBeginEdit?.()
          }}
        >
          <Icon name="edit" size={12} />
        </button>
      ) : null}
      {revertable ? (
        <button
          type="button"
          className={cn(
            'absolute right-1 top-1 z-[1] inline-grid size-6 place-items-center rounded-md',
            'text-muted hover:bg-surface hover:text-fg',
            'opacity-0 vy-transition',
            'group-hover/prompt:opacity-100 group-focus-within/prompt:opacity-100',
            'focus-visible:opacity-100 focus-visible:vy-focus-ring'
          )}
          aria-label="Revert back"
          title="Revert back to this prompt"
          data-no-prompt-edit
          onClick={(e) => {
            e.stopPropagation()
            onRevert?.()
          }}
        >
          <Icon name="revert" size={12} />
        </button>
      ) : null}

      {hasBody ? (
        <div
          ref={bodyRef}
          className={cn(
            'relative overflow-hidden',
            editable && (revertable ? 'pr-14' : 'pr-8'),
            revertable && !editable && 'pr-8',
            clamped && 'mask-fade-bottom'
          )}
          style={clamped ? { maxHeight: TOOL_BODY_CLAMP_PX } : undefined}
        >
          {slashChip ? (
            <div className="flex flex-col gap-2">
              <SlashChip name={slashChip.name} kind={slashChip.kind} />
              {content ? <MarkdownContent content={content} /> : null}
            </div>
          ) : (
            <MarkdownContent content={content} />
          )}
        </div>
      ) : null}

      {overflows ? (
        <button
          type="button"
          className="mt-1 text-xs font-medium text-tertiary vy-transition hover:text-fg"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}

      {item.images?.length || item.attachments?.length ? (
        <div
          className={cn('flex flex-wrap items-center gap-1.5', hasBody ? 'mt-2' : null)}
          data-no-prompt-edit
        >
          {item.images?.map((url, imageIndex) => (
            <ImageChip
              key={`${item.id}-${imageIndex}`}
              url={url}
              label={`Image ${imageIndex + 1}`}
              onClick={() => onImageClick(url, `Image ${imageIndex + 1}`)}
            />
          ))}
          {item.attachments?.map((file, fileIndex) => (
            <FileChip
              key={`${item.id}-file-${fileIndex}`}
              name={file.name}
              chars={file.chars}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
