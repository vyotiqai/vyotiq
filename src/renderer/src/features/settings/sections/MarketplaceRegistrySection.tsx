import { useEffect, useState } from 'react'
import type { Settings } from '@shared/ipc'
import { Button, Input } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { isValidHttpUrl } from '../utils/settingsHelpers'
import { SettingsRow } from '../components/SettingsRow'

/** Registry URL + remote-install acknowledgement — Browse/Installed live in Marketplace view. */
export function MarketplaceRegistrySection({
  settings,
  form,
  onReloadSettings
}: {
  settings: Settings
  form: SettingsFormState
  onReloadSettings?: () => Promise<void>
}) {
  const [registryUrl, setRegistryUrl] = useState(settings.marketplace?.registryUrl ?? '')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(
    null
  )

  useEffect(() => {
    setRegistryUrl(settings.marketplace?.registryUrl ?? '')
  }, [settings.marketplace?.registryUrl])

  const remoteAcked = settings.marketplace?.remoteInstallAcked ?? false

  return (
    <SettingsRow
      stacked
      title="Package registry"
      description="Optional remote catalog URL. Browse and install packages from the Marketplace sidebar. Unsigned packages — install only from sources you trust."
    >
      <div className="flex w-full flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="marketplace-registry-url" className="text-xs text-secondary">
            Registry URL (optional)
          </label>
          <div className="flex gap-2">
            <Input
              id="marketplace-registry-url"
              className="w-full font-mono text-xs"
              value={registryUrl}
              disabled={form.formLocked || busy}
              placeholder="https://registry.example.com"
              aria-invalid={Boolean(
                registryUrl.trim() && !isValidHttpUrl(registryUrl.trim())
              )}
              aria-describedby="marketplace-registry-url-error"
              onChange={(e) => {
                setRegistryUrl(e.target.value)
                setFeedback(null)
              }}
              onBlur={() => {
                const trimmed = registryUrl.trim()
                if (trimmed === (settings.marketplace?.registryUrl ?? '')) return
                if (trimmed && !isValidHttpUrl(trimmed)) {
                  setFeedback({
                    kind: 'error',
                    text: 'Enter a valid http(s) URL — not saved.'
                  })
                  return
                }
                setFeedback(null)
                void form.runUpdate({
                  marketplace: {
                    registryUrl: trimmed,
                    remoteInstallAcked: remoteAcked
                  }
                })
              }}
            />
            <Button
              variant="subtle"
              disabled={form.formLocked || busy}
              onClick={() => {
                void (async () => {
                  const trimmed = registryUrl.trim()
                  if (trimmed && !isValidHttpUrl(trimmed)) {
                    setFeedback({ kind: 'error', text: 'Enter a valid http(s) URL — not saved.' })
                    return
                  }
                  setBusy(true)
                  setFeedback(null)
                  try {
                    await form.runUpdate({
                      marketplace: {
                        registryUrl: trimmed,
                        remoteInstallAcked: remoteAcked
                      }
                    })
                    const res = await window.vyotiq.marketplaceRefreshCatalog()
                    if (res.ok) {
                      setFeedback({
                        kind: 'success',
                        text: `Catalog refreshed (${res.data.packages.length} packages)`
                      })
                      window.dispatchEvent(
                        new CustomEvent('vyotiq:marketplace-catalog-refreshed')
                      )
                    } else setFeedback({ kind: 'error', text: res.error })
                  } finally {
                    setBusy(false)
                  }
                })()
              }}
            >
              Refresh
            </Button>
          </div>
        </div>

        <label className="inline-flex items-start gap-2 text-xs text-secondary">
          <input
            type="checkbox"
            className="mt-0.5 size-3.5 shrink-0 accent-fg"
            checked={remoteAcked}
            disabled={form.formLocked || busy}
            aria-label="Acknowledge marketplace install risk"
            onChange={(e) => {
              void (async () => {
                setBusy(true)
                try {
                  const res = await window.vyotiq.marketplaceAckRemoteInstall(e.target.checked)
                  if (!res.ok) {
                    setFeedback({ kind: 'error', text: res.error })
                    return
                  }
                  await onReloadSettings?.()
                } finally {
                  setBusy(false)
                }
              })()
            }}
          />
          <span>
            I understand marketplace packages (remote catalogs, git/npm/zip, local path folders) and
            MCP endpoints are unsigned. Required once before installing non-bundled packages (or
            confirm when prompted).
          </span>
        </label>

        {feedback ? (
          <p
            id="marketplace-registry-url-error"
            className={`m-0 text-xs [overflow-wrap:anywhere] ${
              feedback.kind === 'error' ? 'text-danger' : 'text-secondary'
            }`}
            role={feedback.kind === 'error' ? 'alert' : 'status'}
          >
            {feedback.text}
          </p>
        ) : null}
      </div>
    </SettingsRow>
  )
}
