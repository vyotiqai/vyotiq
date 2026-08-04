import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { FileChip, ImageChip, MarkdownContent, balanceIncompleteMarkdown, cn } from '@renderer/lib/ui'
import { parseMcpToolInvocation, parseSkillInvocation } from '@shared/slashCommands'
import { TOOL_BODY_CLAMP_PX, USER_PROMPT_SURFACE } from '@renderer/lib/utils/layout'
import type { UserItem } from '../utils/transcriptRows'
import { SlashChip } from './SlashChip'

export function UserPrompt({
  item,
  onImageClick,
  editing = false,
  editComposer,
  onBeginEdit
}: {
  item: UserItem
  onImageClick: (url: string, label: string) => void
  editing?: boolean
  editComposer?: ReactNode
  onBeginEdit?: () => void
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const slashChip = useMemo(() => {
    if (!item.content) return null
    const skill = parseSkillInvocation(item.content)
    if (skill) {
      return {
        kind: 'skill' as const,
        name: skill.skillName,
        userRequest: skill.userRequest
      }
    }
    const mcp = parseMcpToolInvocation(item.content)
    if (mcp) {
      return {
        kind: 'mcp' as const,
        name: `${mcp.serverId}-${mcp.toolName}`,
        userRequest: mcp.userRequest
      }
    }
    return null
  }, [item.content])

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
  const hasBody = Boolean(content) || Boolean(slashChip)

  return (
    <div
      className={cn(
        USER_PROMPT_SURFACE,
        'relative',
        editable &&
          cn(
            'group/prompt cursor-text vy-transition',
            'hover:border-border-strong hover:bg-surface/30',
            'focus-within:vy-focus-ring'
          )
      )}
      onClick={
        editable
          ? (e) => {
              const target = e.target as HTMLElement
              if (target.closest('button, a, [data-no-prompt-edit]')) return
              onBeginEdit?.()
            }
          : undefined
      }
      title={editable ? 'Click to edit' : undefined}
    >
      {editable ? (
        <button
          type="button"
          className={cn(
            'absolute right-1 top-1 z-[1] inline-grid size-6 place-items-center rounded-md',
            'text-muted hover:bg-surface hover:text-fg',
            'opacity-0 vy-transition',
            'group-hover/prompt:opacity-100 group-focus-within/prompt:opacity-100',
            'focus-visible:opacity-100 focus-visible:vy-focus-ring'
          )}
          aria-label="Edit message"
          onClick={(e) => {
            e.stopPropagation()
            onBeginEdit?.()
          }}
        >
          <Icon name="edit" size={12} />
        </button>
      ) : null}

      {hasBody ? (
        <div
          ref={bodyRef}
          className={cn(
            'relative overflow-hidden',
            editable && 'pr-8',
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
