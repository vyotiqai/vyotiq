import type { AccentPreset, FontScale, UiDensity } from '@shared/appearance'
import type { Settings, ThemeId } from '@shared/ipc'
import { Menu } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import {
  ACCENT_OPTIONS,
  DENSITY_OPTIONS,
  FONT_SCALE_OPTIONS,
  THEME_OPTIONS
} from '../constants'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'

export function AppearanceSection({
  settings,
  form,
  onAppearanceChange
}: {
  settings: Settings
  form: SettingsFormState
  onAppearanceChange?: SettingsViewProps['onAppearanceChange']
}) {
  const apply = (partial: Partial<{
    theme: ThemeId
    fontScale: FontScale
    uiDensity: UiDensity
    accentPreset: AccentPreset
  }>): void => {
    form.clearErrors()
    onAppearanceChange?.(partial)
  }

  return (
    <SettingsStack>
      <SettingsGroup title="Theme">
        <SettingsField
          id="appearance-theme"
          title="Color mode"
          hint="Window chrome and interface colors."
          help="System follows the OS light/dark preference. Dark and Light pin the theme."
        >
          <Menu
            aria-label="Theme"
            value={settings.theme}
            options={THEME_OPTIONS}
            searchable={false}
            placement="down"
            disabled={form.formLocked || !onAppearanceChange}
            onChange={(v) => apply({ theme: v as ThemeId })}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Text & layout">
        <SettingsField
          id="appearance-font-scale"
          title="Text size"
          hint="Scales body copy and UI labels."
          help="Small and Large adjust the type scale app-wide. Default matches the designed size."
        >
          <Menu
            aria-label="Text size"
            value={settings.fontScale}
            options={FONT_SCALE_OPTIONS}
            searchable={false}
            placement="down"
            disabled={form.formLocked || !onAppearanceChange}
            onChange={(v) => apply({ fontScale: v as FontScale })}
          />
        </SettingsField>

        <SettingsField
          id="appearance-density"
          title="UI density"
          hint="Control padding and tap targets."
          help="Compact tightens buttons and fields. Comfortable adds more spacing."
        >
          <Menu
            aria-label="UI density"
            value={settings.uiDensity}
            options={DENSITY_OPTIONS}
            searchable={false}
            placement="down"
            disabled={form.formLocked || !onAppearanceChange}
            onChange={(v) => apply({ uiDensity: v as UiDensity })}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Accent">
        <SettingsField
          id="appearance-accent"
          title="Accent color"
          hint="Primary buttons and focus rings."
          help="Neutral keeps the default grayscale accent. Other presets tint accent and focus only."
        >
          <Menu
            aria-label="Accent color"
            value={settings.accentPreset}
            options={ACCENT_OPTIONS}
            searchable={false}
            placement="down"
            disabled={form.formLocked || !onAppearanceChange}
            onChange={(v) => apply({ accentPreset: v as AccentPreset })}
          />
        </SettingsField>
      </SettingsGroup>
    </SettingsStack>
  )
}
