import type { SettingsSection } from '../types'
import { SECTION_LABELS } from '../constants'

export function SettingsSectionHeader({ section }: { section: SettingsSection }) {
  return (
    <h1 className="m-0 mb-5 text-[22px] font-semibold tracking-tight text-fg-strong">
      {SECTION_LABELS[section].title}
    </h1>
  )
}
