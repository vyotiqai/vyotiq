import type { ReactNode } from 'react'
import { Alert } from '@renderer/lib/ui'
import { CHAT_COLUMN, CHAT_GUTTER } from '@renderer/lib/utils/layout'
import { cn } from '@renderer/lib/ui/cn'

export function ChatHeroStage({
  chatBannerError,
  operationalBannerError,
  onDismissError,
  composer,
  belowComposer,
  className
}: {
  chatBannerError?: string | null
  operationalBannerError?: string | null
  onDismissError?: () => void
  composer: ReactNode
  belowComposer?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn('flex min-h-0 flex-1 flex-col items-center justify-center', CHAT_GUTTER, className)}
      data-chat-hero
    >
      {chatBannerError || operationalBannerError ? (
        <div className={cn('mb-4 flex w-full flex-col gap-2', CHAT_COLUMN)}>
          {operationalBannerError ? (
            <Alert className="w-full">{operationalBannerError}</Alert>
          ) : null}
          {chatBannerError ? (
            <Alert className="w-full" onDismiss={onDismissError}>
              {chatBannerError}
            </Alert>
          ) : null}
        </div>
      ) : null}
      <div className={cn('w-full animate-fade-in', CHAT_COLUMN)} data-composer-hero>
        {composer}
        {belowComposer}
      </div>
    </div>
  )
}
