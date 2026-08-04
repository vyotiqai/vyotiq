import type { ReactNode } from 'react'
import type { SettingsSection } from '../types'
import { SECTION_LABELS } from '../constants'

export function SettingsSectionHeader({ section }: { section: SettingsSection }) {
  const { title, description } = SECTION_LABELS[section]
  return (
    <header className="mb-1 border-b border-border pb-4 pt-1">
      <h1 className="m-0 text-base font-medium tracking-[var(--vy-tracking)] text-fg-strong">
        {title}
      </h1>
      {description ? (
        <p className="m-0 mt-1 text-xs leading-snug tracking-[var(--vy-tracking)] text-secondary">
          {description}
        </p>
      ) : null}
    </header>
  )
}
