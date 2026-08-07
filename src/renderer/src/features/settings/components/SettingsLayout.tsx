import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/ui'
import { SETTINGS_COLUMN, SETTINGS_GUTTER } from '@renderer/lib/utils/layout'

export function SettingsLayout({
  nav,
  children
}: {
  nav: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg animate-fade-in">
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        {nav}
        <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-bg">
          <div className={cn('flex w-full flex-col', SETTINGS_GUTTER, SETTINGS_COLUMN)}>
            <div className="flex flex-col pb-7">{children}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
