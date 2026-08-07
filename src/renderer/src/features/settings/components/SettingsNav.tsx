import type { Ref } from 'react'
import { Icon } from '@renderer/lib/icons'
import { NavItem } from '@renderer/lib/ui'
import type { SettingsSection } from '../types'

const SECTIONS: {
  id: SettingsSection
  label: string
  icon: 'home' | 'cpu' | 'bot' | 'marketplace'
}[] = [
  { id: 'general', label: 'General', icon: 'home' },
  { id: 'providers', label: 'Providers', icon: 'cpu' },
  { id: 'agent', label: 'Agent', icon: 'bot' },
  { id: 'marketplace', label: 'Marketplace', icon: 'marketplace' }
]

export function SettingsNav({
  backRef,
  section,
  onClose,
  onSectionChange
}: {
  backRef?: Ref<HTMLButtonElement>
  section: SettingsSection
  onClose: () => void
  onSectionChange: (section: SettingsSection) => void
}) {
  return (
    <nav
      className="flex shrink-0 flex-row items-center gap-1 overflow-x-auto bg-bg px-2 py-2 sm:w-[168px] sm:flex-col sm:items-stretch sm:gap-1 sm:overflow-visible sm:py-2.5"
      aria-label="Settings sections"
    >
      <button
        ref={backRef}
        type="button"
        className="mr-1 inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm text-muted vy-transition hover:bg-surface/50 hover:text-fg sm:mb-1 sm:mr-0 sm:w-full"
        onClick={onClose}
      >
        <Icon name="chevron" size={14} className="rotate-90" />
        Back
      </button>
      <div className="flex min-w-0 flex-1 gap-1 sm:flex-col sm:gap-1">
        {SECTIONS.map(({ id, label, icon }) => (
          <NavItem
            key={id}
            variant="settings"
            label={label}
            icon={icon}
            active={section === id}
            onClick={() => onSectionChange(id)}
          />
        ))}
      </div>
    </nav>
  )
}
