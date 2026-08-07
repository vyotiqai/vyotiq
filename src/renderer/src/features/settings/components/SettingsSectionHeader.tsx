import type { SettingsSection } from '../types'
import { SECTION_LABELS } from '../constants'
import { PageHeader } from '@renderer/lib/ui'

export function SettingsSectionHeader({ section }: { section: SettingsSection }) {
  const { title, description } = SECTION_LABELS[section]
  return <PageHeader title={title} description={description} />
}
