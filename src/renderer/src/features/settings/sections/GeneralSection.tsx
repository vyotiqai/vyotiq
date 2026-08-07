import type { Settings, ThemeId } from '@shared/ipc'
import { PROVIDER_DEFAULTS } from '@shared/providers'
import { findByWorkspacePath, workspacePathsEqual } from '@shared/workspacePathMatch'
import { Button, Menu } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import { THEME_OPTIONS } from '../constants'
import { SettingsRow } from '../components/SettingsRow'
import { WorkspaceOverrideCard } from '../components/WorkspaceOverrideCard'

export function GeneralSection({
  settings,
  form,
  onSetTheme,
  onPickWorkspace,
  activeWorkspacePath,
  openWorkspaces,
  settingsOverridesByPath,
  onSetSettingsOverride
}: {
  settings: Settings
  form: SettingsFormState
  onSetTheme?: (theme: ThemeId) => void
  onPickWorkspace?: SettingsViewProps['onPickWorkspace']
  activeWorkspacePath: string | null
  openWorkspaces: string[]
  settingsOverridesByPath: SettingsViewProps['settingsOverridesByPath']
  onSetSettingsOverride?: SettingsViewProps['onSetSettingsOverride']
}) {
  const providerMeta = PROVIDER_DEFAULTS.find((p) => p.id === settings.provider)

  return (
    <>
      <SettingsRow
        title="Active model"
        description={
          form.workspaceOverrideActive
            ? `${form.displayProviderMeta?.label ?? form.displayProvider} · ${form.displayModel} for the active workspace (override). Global default: ${providerMeta?.label ?? settings.provider} · ${settings.model}.`
            : `${form.displayProviderMeta?.label ?? form.displayProvider} · ${form.displayModel}. Change provider in Providers; pick the model in the composer.`
        }
      >
        <span
          className="min-w-0 max-w-full truncate rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-secondary"
          title={form.displayModel}
        >
          {form.displayModel}
        </span>
      </SettingsRow>

      <SettingsRow
        stacked
        title="Workspaces"
        description="Open workspace tabs. Enable Override for per-workspace provider, model, and agent settings."
      >
        {openWorkspaces.length === 0 ? (
          <p className="m-0 text-xs text-secondary">No workspaces open.</p>
        ) : (
          <div className="flex w-full flex-col gap-2">
            {openWorkspaces.map((path) => (
              <WorkspaceOverrideCard
                key={path}
                path={path}
                isActive={
                  activeWorkspacePath !== null &&
                  workspacePathsEqual(path, activeWorkspacePath)
                }
                globalSettings={settings}
                override={
                  findByWorkspacePath(settingsOverridesByPath ?? {}, path) ?? undefined
                }
                disabled={form.formLocked || !onSetSettingsOverride}
                onSetOverride={onSetSettingsOverride ?? (async () => ({ ok: true as const }))}
                onOverrideError={(message) => form.setErrorMessage(message)}
              />
            ))}
          </div>
        )}
        {onPickWorkspace ? (
          <Button
            variant="subtle"
            pending={form.pickingWorkspace}
            disabled={form.formLocked}
            onClick={() => {
              form.clearErrors()
              form.setModelsInfo(null)
              form.setPickingWorkspace(true)
              void Promise.resolve(onPickWorkspace())
                .catch((err: unknown) => {
                  form.setErrorMessage(err instanceof Error ? err.message : String(err))
                })
                .finally(() => form.setPickingWorkspace(false))
            }}
          >
            {form.pickingWorkspace ? 'Opening…' : 'Add workspace'}
          </Button>
        ) : null}
      </SettingsRow>

      {onSetTheme ? (
        <SettingsRow title="Appearance" description="Window chrome theme.">
          <Menu
            aria-label="Theme"
            value={settings.theme}
            options={THEME_OPTIONS}
            searchable={false}
            placement="down"
            disabled={form.formLocked}
            onChange={(v) => {
              form.clearErrors()
              onSetTheme(v as ThemeId)
            }}
          />
        </SettingsRow>
      ) : null}

      <SettingsRow
        title="Share crash & error reports"
        description={
          form.dsnConfigured
            ? 'Optional opt-in. Never includes chat contents, API keys, or file bodies. Local rotating logs are always written.'
            : 'Reporting unavailable in this build (no Sentry DSN). Local rotating logs are always written.'
        }
      >
        <label className="inline-flex items-center gap-2 text-xs text-secondary">
          <input
            type="checkbox"
            className="size-3.5 accent-fg"
            aria-label="Share crash and error reports"
            disabled={form.formLocked || !form.dsnConfigured}
            checked={form.dsnConfigured && settings.telemetryEnabled}
            onChange={(e) => {
              void form.runUpdate({ telemetryEnabled: e.target.checked })
            }}
          />
          {settings.telemetryEnabled && form.dsnConfigured ? 'On' : 'Off'}
        </label>
      </SettingsRow>

      <SettingsRow
        title="Logs"
        description={
          form.logsPath
            ? `Local rotating logs at ${form.logsPath}`
            : 'Open the local logs folder for troubleshooting.'
        }
      >
        <Button
          variant="subtle"
          pending={form.openingLogs}
          disabled={form.formLocked}
          onClick={() => {
            form.clearErrors()
            form.setOpeningLogs(true)
            void (window.vyotiq?.openLogsDir?.() ?? Promise.reject(new Error('Logs API unavailable')))
              .then((res) => {
                if (!res.ok) form.setErrorMessage(res.error)
              })
              .catch((err: unknown) => {
                form.setErrorMessage(err instanceof Error ? err.message : String(err))
              })
              .finally(() => form.setOpeningLogs(false))
          }}
        >
          {form.openingLogs ? 'Opening…' : 'Open logs folder'}
        </Button>
      </SettingsRow>

      <SettingsRow
        stacked
        title="Recent crashes"
        description="Last renderer / GPU / utility process exits retained for diagnostics. Crashpad dumps are often empty for these exits — logs and this list are the useful signal."
      >
        {form.crashSnippets.length === 0 ? (
          <p className="m-0 text-xs text-secondary">No crashes recorded this install.</p>
        ) : (
          <ul className="m-0 flex max-h-40 list-none flex-col gap-1.5 overflow-auto p-0">
            {form.crashSnippets.map((snippet, i) => (
              <li
                key={`${snippet.at}-${snippet.kind}-${i}`}
                className="rounded-md border border-border/60 bg-surface px-2.5 py-1.5 text-caption text-secondary"
              >
                <span className="font-medium text-fg">
                  {snippet.kind === 'renderer' ? 'Renderer' : 'Child'} · {snippet.reason}
                </span>
                <span className="mt-0.5 block text-muted">
                  {new Date(snippet.at).toLocaleString()}
                  {snippet.exitCodeHex
                    ? ` · ${snippet.exitCodeHex}`
                    : snippet.exitCode != null
                      ? ` · exit ${snippet.exitCode}`
                      : ''}
                  {snippet.processType ? ` · ${snippet.processType}` : ''}
                  {snippet.name ? ` · ${snippet.name}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SettingsRow>
    </>
  )
}
