import type { ReactNode } from 'react'
import { SETTINGS_COLUMN } from '@renderer/lib/utils/layout'

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
          <div className={`flex w-full flex-col px-4 sm:px-0 ${SETTINGS_COLUMN}`}>
            <div className="flex flex-col px-1 pb-7 sm:px-5">{children}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
