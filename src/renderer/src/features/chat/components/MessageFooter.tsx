import { useCallback, useEffect, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Tooltip, cn } from '@renderer/lib/ui'
import { copyText } from '@renderer/lib/markdown/copyText'
import { relativeTimeAgo } from '@shared/utils/timeFormat'

const COPIED_FEEDBACK_MS = 1600

export function MessageFooter({ content, at }: { content: string; at?: string }) {
  const [copied, setCopied] = useState(false)
  const timestamp = at ? relativeTimeAgo(at) : ''

  useEffect(() => {
    if (!copied) return undefined
    const id = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
    return () => window.clearTimeout(id)
  }, [copied])

  const onCopy = useCallback(() => {
    void copyText(content).then((didCopy) => {
      if (didCopy) setCopied(true)
    })
  }, [content])

  if (!content.trim()) return null

  return (
    <div className="mt-1 flex items-center justify-end gap-2 text-caption text-tertiary">
      {timestamp ? <span className="tabular-nums">{timestamp}</span> : null}
      <Tooltip content={copied ? 'Copied' : 'Copy message'}>
        <button
          type="button"
          className={cn(
            'inline-grid size-6 place-items-center rounded-sm vy-transition',
            'opacity-0 hover:bg-surface hover:text-fg focus-visible:opacity-100',
            'group-hover/message:opacity-100 [@media(hover:none)]:opacity-100',
            copied && 'opacity-100 text-success'
          )}
          onClick={onCopy}
          aria-label={copied ? 'Copied' : 'Copy message'}
        >
          <Icon name={copied ? 'check' : 'copy'} size={14} />
        </button>
      </Tooltip>
    </div>
  )
}
