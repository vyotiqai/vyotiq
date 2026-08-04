import { AlertBlock } from '@renderer/lib/ui'
import type { SettingsViewProps } from './types'
import { useSettingsForm } from './hooks/useSettingsForm'
import { SettingsLayout } from './components/SettingsLayout'
import { SettingsNav } from './components/SettingsNav'
import { SettingsSectionHeader } from './components/SettingsSectionHeader'
import { GeneralSection } from './sections/GeneralSection'
import { ProvidersSection } from './sections/ProvidersSection'
import { AgentSection } from './sections/AgentSection'
import { MarketplaceRegistrySection } from './sections/MarketplaceRegistrySection'

export function SettingsView(props: SettingsViewProps) {
  const {
    settings,
    secrets,
    backRef,
    onClose,
    onClearSecret,
    onSetTheme,
    onPickWorkspace,
    activeWorkspacePath = null,
    openWorkspaces = [],
    settingsOverridesByPath = {},
    onSetSettingsOverride
  } = props

  const form = useSettingsForm(props)

  const renderSection = () => {
    switch (form.section) {
      case 'general':
        return (
          <GeneralSection
            settings={settings}
            form={form}
            onSetTheme={onSetTheme}
            onPickWorkspace={onPickWorkspace}
            activeWorkspacePath={activeWorkspacePath}
            openWorkspaces={openWorkspaces}
            settingsOverridesByPath={settingsOverridesByPath}
            onSetSettingsOverride={onSetSettingsOverride}
          />
        )
      case 'providers':
        return (
          <ProvidersSection
            settings={settings}
            secrets={secrets}
            form={form}
            onClearSecret={onClearSecret}
          />
        )
      case 'agent':
        return <AgentSection form={form} />
      case 'marketplace':
        return (
          <MarketplaceRegistrySection
            settings={settings}
            form={form}
            onReloadSettings={props.onReloadSettings}
          />
        )
      default: {
        const _exhaustive: never = form.section
        return _exhaustive
      }
    }
  }

  return (
    <SettingsLayout
      nav={
        <SettingsNav
          backRef={backRef}
          section={form.section}
          onClose={onClose}
          onSectionChange={form.navigateSection}
        />
      }
    >
      <SettingsSectionHeader section={form.section} />
      {renderSection()}
      {form.displayError && !form.errorField ? (
        <AlertBlock className="mt-3">{form.displayError}</AlertBlock>
      ) : null}
    </SettingsLayout>
  )
}
