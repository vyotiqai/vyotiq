import { useCallback, useEffect, useState } from 'react'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { CodeIndexEmbedderSetting, CodeIndexRuntimeStatus } from '@shared/ipc'
import { Input, Switch, Button, Menu } from '@renderer/lib/ui'
import { CODEINDEX_EMBEDDER_OPTIONS } from '../constants'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'

function phaseLabel(status: CodeIndexRuntimeStatus | null): string {
  if (!status) return 'Unknown'
  switch (status.phase) {
    case 'ready':
      return `Ready · ${status.modelId || 'model'}`
    case 'downloading': {
      const pct =
        status.progress != null ? ` ${Math.round(status.progress * 100)}%` : ''
      return `Downloading${pct}${status.message ? ` · ${status.message}` : ''}`
    }
    case 'loading':
      return status.message ?? 'Loading model'
    case 'indexing': {
      const ip = status.indexProgress
      if (ip) {
        const kind = ip.kind === 'code' ? 'Code index' : 'Sparse grep'
        return `${kind} · ${ip.stage}`
      }
      const pct =
        status.progress != null ? ` · ${Math.round(status.progress * 100)}%` : ''
      return status.message ?? `Indexing${pct}`
    }
    case 'fallback_hash':
      return `Fallback hash${status.message ? ` · ${status.message}` : ''}`
    case 'error':
      return `Error${status.error ? `: ${status.error}` : ''}`
    case 'idle':
      return status.message ?? 'Idle'
    default: {
      const _exhaustive: never = status.phase
      return _exhaustive
    }
  }
}

function IndexProgressPanel({ status }: { status: CodeIndexRuntimeStatus | null }) {
  if (!status) return null
  const showBar =
    status.phase === 'downloading' ||
    status.phase === 'indexing' ||
    status.phase === 'loading'
  const pct =
    status.progress != null && Number.isFinite(status.progress)
      ? Math.max(0, Math.min(100, Math.round(status.progress * 100)))
      : null
  const ip = status.indexProgress
  const showDetail = ip != null && status.phase === 'indexing'

  return (
    <div className="flex w-full flex-col gap-1.5">
      <p className="m-0 text-xs text-secondary">{phaseLabel(status)}</p>
      {showBar && pct != null ? (
        <div
          className="h-1.5 w-full overflow-hidden rounded-sm bg-border"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label="Index progress"
        >
          <div
            className="h-full bg-accent transition-[width] duration-100 ease-linear"
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
      {showDetail ? (
        <div className="m-0 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-secondary">
          <span>
            {ip.filesDone}/{ip.filesTotal} scanned
          </span>
          <span className="text-right">
            {ip.embedChunks > 0 ? `${ip.embedChunks} chunks embedded` : '\u00a0'}
          </span>
          <span>
            {ip.indexed} updated · {ip.skipped} unchanged
            {ip.removed > 0 ? ` · ${ip.removed} removed` : ''}
          </span>
          <span className="text-right text-muted">
            {ip.indexed + ip.skipped > 0
              ? `${ip.indexed + ip.skipped} text files`
              : '\u00a0'}
          </span>
          {ip.currentPath ? (
            <span className="col-span-2 truncate font-mono text-[10px]" title={ip.currentPath}>
              {ip.currentPath}
            </span>
          ) : null}
        </div>
      ) : status.phase === 'indexing' && status.message ? (
        <p className="m-0 text-[11px] text-secondary">{status.message}</p>
      ) : null}
    </div>
  )
}

export function IndexingSection({ form }: { form: SettingsFormState }) {
  const codeIndex = form.settings.codeIndex ?? {
    enabled: true,
    embedder: 'mdenseon' as const,
    autoDownload: true,
    ollamaModel: 'nomic-embed-text'
  }
  const [runtime, setRuntime] = useState<CodeIndexRuntimeStatus | null>(null)
  const [reindexBusy, setReindexBusy] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)

  const refreshStatus = useCallback(() => {
    void window.vyotiq.codeIndexStatus().then((res) => {
      if (res.ok) {
        const { settings: _s, ...rest } = res.data
        setRuntime(rest)
        setStatusError(null)
      } else {
        setStatusError(res.error ?? 'Failed to load index status')
      }
    })
  }, [])

  useEffect(() => {
    refreshStatus()
    const unsub =
      typeof window.vyotiq.onCodeIndexStatus === 'function'
        ? window.vyotiq.onCodeIndexStatus((status) => {
            setRuntime(status)
            setStatusError(null)
          })
        : undefined
    // Fallback poll only when push subscription is unavailable.
    const id =
      unsub == null ? window.setInterval(refreshStatus, 1000) : window.setInterval(refreshStatus, 8000)
    return () => {
      unsub?.()
      window.clearInterval(id)
    }
  }, [refreshStatus, codeIndex.embedder, codeIndex.enabled, codeIndex.autoDownload])

  const patchCodeIndex = (partial: Partial<typeof codeIndex>) => {
    void form.runUpdate({
      codeIndex: { ...codeIndex, ...partial }
    })
  }

  return (
    <SettingsStack>
      <SettingsGroup title="Codebase indexing">
        <SettingsField
          id="codeindex-enabled"
          title="Enable codebase index"
          hint="Powers codebase_search (local hybrid retrieval)."
          help="Index lives under app userData (not the project tree). Code never leaves the machine for the local ONNX path."
        >
          <Switch
            size="md"
            checked={codeIndex.enabled}
            disabled={form.formLocked}
            label="Enable codebase index"
            onCheckedChange={(checked) => patchCodeIndex({ enabled: checked })}
          />
        </SettingsField>

        <SettingsField
          id="codeindex-embedder"
          title="Embedder"
          hint="mDenseOn (LightOn dense ONNX) · Ollama · hash fallback. Reindex after changing."
          help="Default setting is mDenseOn. Auto-download fetches DenseOn INT8 ONNX (~150MB into userData); mDenseOn weights are used only if already on disk. Ollama uses your local server. Hash is offline bag-of-tokens. Closing open indexes happens automatically; click Reindex workspace to rebuild under the new embedder."
        >
          <Menu
            aria-label="Codebase embedder"
            value={codeIndex.embedder}
            options={CODEINDEX_EMBEDDER_OPTIONS}
            searchable={false}
            placement="down"
            disabled={form.formLocked || !codeIndex.enabled}
            onChange={(v) => patchCodeIndex({ embedder: v as CodeIndexEmbedderSetting })}
          />
        </SettingsField>

        <SettingsField
          id="codeindex-auto-download"
          title="Auto-download model"
          hint="Fetch DenseOn ONNX on first use (not mDenseOn)."
          help="When on, downloads DenseOn INT8 bootstrap weights under userData/codeindex/models/. mDenseOn is never auto-fetched (no public ONNX yet). When off, falls back to hash until weights are present."
        >
          <Switch
            size="md"
            checked={codeIndex.autoDownload}
            disabled={form.formLocked || !codeIndex.enabled || codeIndex.embedder !== 'mdenseon'}
            label="Auto-download embedder model"
            onCheckedChange={(checked) => patchCodeIndex({ autoDownload: checked })}
          />
        </SettingsField>

        {codeIndex.embedder === 'ollama' ? (
          <SettingsField
            id="codeindex-ollama-model"
            title="Ollama embedding model"
            hint="Model name passed to /api/embeddings."
            help="Uses the Ollama base URL from Settings → Providers."
          >
            <Input
              className="max-w-xs"
              aria-label="Ollama embedding model"
              disabled={form.formLocked}
              defaultValue={codeIndex.ollamaModel}
              key={`ci-ollama-${codeIndex.ollamaModel}`}
              onBlur={(e) => {
                const v = e.target.value.trim() || 'nomic-embed-text'
                if (v !== codeIndex.ollamaModel) patchCodeIndex({ ollamaModel: v })
              }}
            />
          </SettingsField>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Index status">
        <SettingsField
          id="codeindex-status"
          title="Index status"
          hint="Live walk / hash / embed progress for the local semantic and sparse indexes."
          help="Scanned counts every walked path. Updated / unchanged apply only to text files that are content-hashed. Non-text and oversized files are skipped without those counters."
          wide
        >
          <div className="flex flex-col items-start gap-2">
            <IndexProgressPanel status={runtime} />
            {runtime?.error ? (
              <p className="m-0 w-full text-xs text-danger" role="alert">
                {runtime.error}
              </p>
            ) : null}
            {statusError ? (
              <p className="m-0 w-full text-xs text-danger" role="alert">
                {statusError}
              </p>
            ) : null}
            <Button
              type="button"
              variant="subtle"
              disabled={form.formLocked || reindexBusy || !codeIndex.enabled}
              onClick={() => {
                setReindexBusy(true)
                setStatusError(null)
                void window.vyotiq
                  .codeIndexReindex()
                  .then((res) => {
                    if (!res.ok) {
                      setStatusError(res.error ?? 'Reindex failed')
                      return
                    }
                    refreshStatus()
                  })
                  .finally(() => setReindexBusy(false))
              }}
            >
              {reindexBusy ? 'Reindexing…' : 'Reindex workspace'}
            </Button>
          </div>
        </SettingsField>
      </SettingsGroup>
    </SettingsStack>
  )
}
