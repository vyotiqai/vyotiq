import type { ReactNode } from 'react'
import { InlineInstanceGateBanner } from './InlineInstanceGateBanner'
import type { InlineInstanceGate } from '../hooks/useInlineInstanceUi'
import { CHAT_COLUMN, CHAT_GUTTER, CHAT_STAGE_INSET } from '@renderer/lib/utils/layout'
import { cn } from '@renderer/lib/ui/cn'

export function ChatTranscriptStage({
  sideRailPad = false,
  pendingGates,
  onOpenInstance,
  transcript,
  composer
}: {
  sideRailPad?: boolean
  pendingGates: InlineInstanceGate[]
  onOpenInstance: (instanceRunId: string) => void
  transcript: ReactNode
  composer?: ReactNode
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-chat-stage>
      {pendingGates.length > 0 ? (
        <div className={cn('shrink-0 pt-2', sideRailPad ? CHAT_STAGE_INSET : CHAT_GUTTER)}>
          <div className={CHAT_COLUMN}>
            <InlineInstanceGateBanner gates={pendingGates} onOpenInstance={onOpenInstance} />
          </div>
        </div>
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col">{transcript}</div>
      {composer}
    </div>
  )
}
