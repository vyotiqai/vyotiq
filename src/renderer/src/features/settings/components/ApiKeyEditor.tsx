import { SECRET_PROVIDERS, type SecretProvider } from '@shared/ipc'
import { providerLabel } from '@shared/providers'
import { Input, Button, cn } from '@renderer/lib/ui'

export function ApiKeyEditor({
  secrets,
  settingsProvider,
  encryptionAvailable,
  keyProvider,
  keyDraft,
  keyHasSaved,
  keyProviderLabel,
  formLocked,
  savingKey,
  clearingKey,
  errorField,
  displayError,
  onKeyDraftChange,
  onSelectProvider,
  onSaveKey,
  onClearKey
}: {
  secrets: Record<SecretProvider, boolean>
  settingsProvider: SecretProvider
  encryptionAvailable: boolean
  keyProvider: SecretProvider
  keyDraft: string
  keyHasSaved: boolean
  keyProviderLabel: string
  formLocked: boolean
  savingKey: boolean
  clearingKey: boolean
  errorField: string | null
  displayError: string | null
  onKeyDraftChange: (value: string) => void
  onSelectProvider: (provider: SecretProvider) => void
  onSaveKey: () => void
  onClearKey: () => void
}) {
  return (
    <>
      {!encryptionAvailable ? (
        <p className="m-0 mb-2 w-full text-xs leading-snug text-secondary" role="status">
          Secure storage unavailable — provider keys will show as missing until the OS
          keychain/credential store is available.
        </p>
      ) : null}
      <div className="flex w-full flex-col gap-2">
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="API key status">
          {SECRET_PROVIDERS.map((id) => {
            const saved = secrets[id]
            const editing = id === keyProvider
            const isActive = id === settingsProvider
            return (
              <li key={id}>
                <button
                  type="button"
                  className={cn(
                    'rounded-md border px-2 py-1 text-xs tracking-[var(--vy-tracking)] vy-transition',
                    editing || isActive
                      ? 'border-fg/30 bg-surface-2 text-fg-strong'
                      : 'border-border bg-surface text-secondary hover:text-fg',
                    saved ? '' : 'opacity-80'
                  )}
                  aria-pressed={editing}
                  disabled={(!encryptionAvailable && !saved) || formLocked}
                  onClick={() => {
                    onSelectProvider(id)
                  }}
                >
                  {providerLabel(id)}
                  <span className="ml-1 text-muted">
                    {isActive
                      ? '· active'
                      : saved
                        ? '· saved'
                        : encryptionAvailable
                          ? '· missing'
                          : '· unavailable'}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="apikey"
            className="min-w-[200px] flex-1"
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`API key (${keyProviderLabel})`}
            aria-invalid={errorField === 'apikey' ? true : undefined}
            aria-describedby={errorField === 'apikey' ? 'apikey-error' : undefined}
            value={keyDraft}
            placeholder={
              !encryptionAvailable
                ? 'Secure storage unavailable'
                : keyHasSaved
                  ? '•••••••• (saved)'
                  : 'Paste API key'
            }
            disabled={!encryptionAvailable || savingKey || clearingKey}
            onChange={(e) => onKeyDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && keyDraft.trim() && !savingKey) {
                e.preventDefault()
                onSaveKey()
              }
            }}
          />
          {errorField === 'apikey' && displayError ? (
            <p id="apikey-error" className="m-0 w-full text-xs text-danger" role="alert">
              {displayError}
            </p>
          ) : null}
          <Button
            variant="primary"
            pending={savingKey}
            disabled={!encryptionAvailable || !keyDraft.trim() || clearingKey}
            onClick={onSaveKey}
          >
            {savingKey ? 'Saving…' : 'Save key'}
          </Button>
          {keyHasSaved ? (
            <Button
              variant="subtle"
              pending={clearingKey}
              disabled={savingKey}
              onClick={onClearKey}
            >
              {clearingKey ? 'Clearing…' : 'Clear'}
            </Button>
          ) : null}
        </div>
      </div>
    </>
  )
}
