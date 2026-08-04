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
  { id: 'marketplace', label: 'Registry', icon: 'marketplace' }
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
      className="flex shrink-0 flex-row items-center gap-1 overflow-x-auto bg-bg px-2 py-2 sm:w-[160px] sm:flex-col sm:items-stretch sm:gap-px sm:overflow-visible sm:py-2.5"
      aria-label="Settings sections"
    >
      <button
        ref={backRef}
        type="button"
        className="mr-1 inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted vy-transition hover:bg-surface hover:text-fg sm:mb-1.5 sm:mr-0 sm:w-full"
        onClick={onClose}
      >
        <Icon name="chevron" size={14} className="rotate-90" />
        Back
      </button>
      <div className="flex min-w-0 flex-1 gap-1 sm:flex-col sm:gap-px">
        {SECTIONS.map(({ id, label, icon }) => (
          <NavItem
            key={id}
            variant="settings"
            label={label}
            icon={icon}
            active={section === id}
            current={section === id}
            onClick={() => onSectionChange(id)}
          />
        ))}
      </div>
    </nav>
  )
}
