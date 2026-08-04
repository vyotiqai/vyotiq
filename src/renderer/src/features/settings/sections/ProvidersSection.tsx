import { SECRET_PROVIDERS, type ProviderId, type Settings } from '@shared/ipc'
import { providerLabel } from '@shared/providers'
import { Input, Menu, Button } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import { ACTIVE_PROVIDER_OPTIONS } from '../constants'
import { SettingsRow } from '../components/SettingsRow'
import { ApiKeyEditor } from '../components/ApiKeyEditor'

export function ProvidersSection({
  settings,
  secrets,
  form,
  onClearSecret
}: {
  settings: Settings
  secrets: SettingsViewProps['secrets']
  form: SettingsFormState
  onClearSecret: SettingsViewProps['onClearSecret']
}) {
  return (
    <>
      <SettingsRow
        title="Active provider"
        description="Used for chat and Refresh models. Selecting a provider here (or an API key chip) makes it active."
      >
        <Menu
          aria-label="Active provider"
          value={settings.provider}
          options={ACTIVE_PROVIDER_OPTIONS}
          searchable={false}
          placement="down"
          disabled={form.formLocked}
          onChange={(v) => {
            void form.setActiveProvider(v as ProviderId)
          }}
        />
      </SettingsRow>

      {form.activeNeedsKey && form.savedKeyProviders.length > 0 ? (
        <p
          className="m-0 border-b border-border py-3 text-xs leading-snug text-secondary [overflow-wrap:anywhere]"
          role="status"
        >
          Active provider is {providerLabel(settings.provider)} but its API key is
          missing. Switch to a provider with a saved key:{' '}
          {form.savedKeyProviders.map((id) => (
            <button
              key={id}
              type="button"
              className="mr-1.5 inline-flex rounded-sm border border-border bg-surface px-1.5 py-0.5 text-xs text-fg-strong vy-transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]"
              disabled={form.formLocked}
              onClick={() => {
                void form.setActiveProvider(id)
              }}
            >
              Use {providerLabel(id)}
            </button>
          ))}
        </p>
      ) : null}

      <SettingsRow
        title="Ollama base URL"
        description="Local daemon by default. Saving an Ollama API key switches to Cloud (https://ollama.com) automatically."
      >
        <Input
          id="ollama"
          className="w-[240px] max-w-[46vw]"
          aria-label="Ollama base URL"
          aria-invalid={form.errorField === 'ollama' ? true : undefined}
          aria-describedby={form.errorField === 'ollama' ? 'ollama-error' : undefined}
          disabled={form.formLocked}
          value={form.ollamaUrl}
          onChange={(e) => form.setOllamaUrl(e.target.value)}
          onBlur={() => {
            void form.commitOllamaUrl()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            }
          }}
        />
        {form.fieldError.ollama}
      </SettingsRow>

      <SettingsRow
        title="Custom OpenAI base URL"
        description="OpenAI-compatible base (…/v1 or vendor mount like DeepInfra …/v1/openai). Loopback and private LAN hosts stay key-optional; public hosts need a Custom API key."
      >
        <Input
          id="custom-openai-url"
          className="w-[240px] max-w-[46vw]"
          aria-label="Custom OpenAI base URL"
          aria-invalid={form.errorField === 'customUrl' ? true : undefined}
          aria-describedby={form.errorField === 'customUrl' ? 'custom-url-error' : undefined}
          disabled={form.formLocked}
          value={form.customUrl}
          onChange={(e) => form.setCustomUrl(e.target.value)}
          onBlur={() => {
            void form.commitCustomUrl()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            }
          }}
        />
        {form.fieldError.customUrl}
      </SettingsRow>

      <SettingsRow
        stacked
        title="API keys"
        description={
          form.encryptionAvailable
            ? `OS secure storage · ${form.savedKeyCount}/${SECRET_PROVIDERS.length} saved. Selecting a provider sets it active and opens its key editor.`
            : 'OS secure storage is unavailable on this system. API keys cannot be saved or decrypted until it is enabled.'
        }
      >
        <ApiKeyEditor
          secrets={secrets}
          settingsProvider={settings.provider}
          encryptionAvailable={form.encryptionAvailable}
          keyProvider={form.keyProvider}
          keyDraft={form.keyDraft}
          keyHasSaved={form.keyHasSaved}
          keyProviderLabel={form.keyProviderLabel}
          formLocked={form.formLocked}
          savingKey={form.savingKey}
          clearingKey={form.clearingKey}
          errorField={form.errorField}
          displayError={form.displayError}
          onKeyDraftChange={form.setKeyDraft}
          onSelectProvider={(id) => {
            void form.setActiveProvider(id)
          }}
          onSaveKey={() => {
            void form.saveKey()
          }}
          onClearKey={() => {
            void form.clearKey(onClearSecret)
          }}
        />
      </SettingsRow>

      <SettingsRow
        title="Refresh models"
        description={`Reload the live catalog for ${form.providerMeta?.label ?? settings.provider}.`}
      >
        <Button
          variant="subtle"
          pending={form.refreshingModels}
          disabled={form.busy && !form.refreshingModels}
          onClick={() => {
            void form.refreshModels()
          }}
        >
          {form.refreshingModels ? 'Refreshing…' : 'Refresh models'}
        </Button>
      </SettingsRow>
      {form.modelsInfo ? (
        <p
          className="m-0 border-b border-border py-3 text-xs text-secondary [overflow-wrap:anywhere]"
          role="status"
        >
          {form.modelsInfo}
        </p>
      ) : null}
    </>
  )
}
