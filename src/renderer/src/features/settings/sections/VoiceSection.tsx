import { useCallback, useEffect, useState } from 'react'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type {
  DictationEngine,
  DictationLocalModelId,
  DictationRuntimeStatus,
  DictationWaveformStyle,
  SecretProvider
} from '@shared/ipc'
import { DEFAULT_DICTATION_SETTINGS } from '@shared/ipc'
import { DICTATION_LOCAL_CATALOG, isQwen3AsrModelId } from '@shared/dictation'
import { Button, Input, Menu, type MenuOption } from '@renderer/lib/ui'
import { DICTATION_ENGINE_OPTIONS, DICTATION_WAVEFORM_STYLE_OPTIONS } from '../constants'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'

const WHISPER_MODELS = DICTATION_LOCAL_CATALOG.filter((m) => m.backend === 'whisper')
const QWEN_MODELS = DICTATION_LOCAL_CATALOG.filter((m) => m.backend === 'qwen3-asr')

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function engineKeyHint(
  engine: DictationEngine,
  secrets: Record<SecretProvider, boolean>
): string {
  switch (engine) {
    case 'openai':
      return secrets.openai
        ? 'OpenAI API key is saved.'
        : 'No OpenAI API key — add one in Settings → Providers.'
    case 'openrouter':
      return secrets.openrouter
        ? 'OpenRouter API key is saved.'
        : 'No OpenRouter API key — add one in Settings → Providers.'
    case 'local':
      return 'Works offline after a model is installed. English only.'
    case 'qwen3-asr':
      return 'Point this at a running vLLM or qwen-asr-serve endpoint in Settings → Voice.'
    default: {
      const _exhaustive: never = engine
      return _exhaustive
    }
  }
}

function cardStatusLabel(
  modelId: DictationLocalModelId,
  status: DictationRuntimeStatus | null
): string {
  if (!status) return 'Unknown'
  if (status.phase === 'downloading' && status.activeModelId === modelId) {
    const pct =
      status.progress != null ? ` ${Math.round(status.progress * 100)}%` : ''
    return `Downloading${pct}`
  }
  if (status.phase === 'loading' && status.activeModelId === modelId) {
    return status.message ?? 'Loading'
  }
  if (status.phase === 'error' && status.activeModelId === modelId) {
    return `Error${status.error ? `: ${status.error}` : ''}`
  }
  const inst = status.installed.find((m) => m.id === modelId)
  if (inst?.loaded) return 'Ready · loaded'
  if (inst) return 'Ready · on disk'
  return 'Not installed'
}

function VoiceProgressBar({
  status,
  modelId
}: {
  status: DictationRuntimeStatus | null
  modelId: DictationLocalModelId
}) {
  if (!status) return null
  const active =
    (status.phase === 'downloading' || status.phase === 'loading') &&
    status.activeModelId === modelId
  if (!active) return null
  const pct =
    status.progress != null && Number.isFinite(status.progress)
      ? Math.max(0, Math.min(100, Math.round(status.progress * 100)))
      : null
  const label =
    status.phase === 'loading'
      ? `${modelId} load progress`
      : `${modelId} download progress`
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-sm bg-border"
      role="progressbar"
      aria-valuemin={pct == null ? undefined : 0}
      aria-valuemax={pct == null ? undefined : 100}
      aria-valuenow={pct ?? undefined}
      aria-label={label}
    >
      <div
        className={
          pct == null
            ? 'h-full w-2/5 bg-accent motion-safe:animate-pulse'
            : 'h-full bg-accent transition-[width] duration-100 ease-linear'
        }
        style={pct == null ? undefined : { width: `${pct}%` }}
      />
    </div>
  )
}

export function VoiceSection({
  form,
  secrets
}: {
  form: SettingsFormState
  secrets: Record<SecretProvider, boolean>
}) {
  const dictation = form.settings.dictation ?? DEFAULT_DICTATION_SETTINGS
  const [runtime, setRuntime] = useState<DictationRuntimeStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [serverUrl, setServerUrl] = useState(dictation.qwen3AsrServerUrl)
  const [serverKey, setServerKey] = useState(dictation.qwen3AsrApiKey)

  const refreshStatus = useCallback(() => {
    void window.vyotiq.dictationStatus().then((res) => {
      if (res.ok) {
        setRuntime(res.data)
        setStatusError(null)
      } else {
        setStatusError(res.error ?? 'Failed to load voice status')
      }
    })
  }, [])

  useEffect(() => {
    setServerUrl(dictation.qwen3AsrServerUrl)
    setServerKey(dictation.qwen3AsrApiKey)
  }, [dictation.qwen3AsrServerUrl, dictation.qwen3AsrApiKey])

  useEffect(() => {
    refreshStatus()
    const unsub =
      typeof window.vyotiq.onDictationStatus === 'function'
        ? window.vyotiq.onDictationStatus((status) => {
            setRuntime(status)
            setStatusError(null)
          })
        : undefined
    const id =
      unsub == null
        ? window.setInterval(refreshStatus, 1000)
        : window.setInterval(refreshStatus, 8000)
    return () => {
      unsub?.()
      window.clearInterval(id)
    }
  }, [refreshStatus, dictation.engine, dictation.localModelId])

  const localInstalled = (runtime?.installed.length ?? 0) > 0
  const downloading = runtime?.phase === 'downloading' || runtime?.phase === 'loading'
  const engineOptions: MenuOption[] = DICTATION_ENGINE_OPTIONS.map((opt) =>
    opt.value === 'local' ? { ...opt, disabled: !localInstalled } : opt
  )

  const patchEngine = (engine: DictationEngine) => {
    if (engine === 'local' && !localInstalled) return
    let localModelId: DictationLocalModelId | '' =
      dictation.localModelId ||
      runtime?.loadedModelId ||
      runtime?.installed[0]?.id ||
      ''
    if (engine === 'qwen3-asr' && !isQwen3AsrModelId(localModelId)) {
      localModelId = QWEN_MODELS[0]?.id ?? ''
    }
    if (engine === 'local' && !WHISPER_MODELS.some((m) => m.id === localModelId)) {
      localModelId = runtime?.loadedModelId || runtime?.installed[0]?.id || WHISPER_MODELS[0]?.id || ''
    }
    void form.runUpdate({ dictation: { ...dictation, engine, localModelId } })
  }

  const patchLocalModelId = (localModelId: DictationLocalModelId) => {
    if (dictation.localModelId === localModelId) return
    void form.runUpdate({ dictation: { ...dictation, localModelId } })
  }

  const patchWaveformStyle = (waveformStyle: DictationWaveformStyle) => {
    if ((dictation.waveformStyle ?? 'bars') === waveformStyle) return
    void form.runUpdate({ dictation: { ...dictation, waveformStyle } })
  }

  const patchServerUrl = (value: string) => {
    void form.runUpdate({ dictation: { ...dictation, qwen3AsrServerUrl: value } })
  }

  const patchServerKey = (value: string) => {
    void form.runUpdate({ dictation: { ...dictation, qwen3AsrApiKey: value } })
  }

  const runModelAction = (
    action: () => Promise<{ ok: true; data: DictationRuntimeStatus } | { ok: false; error?: string }>
  ) => {
    setBusy(true)
    setStatusError(null)
    void action()
      .then((res) => {
        if (!res.ok) {
          setStatusError(res.error ?? 'Voice action failed')
          return
        }
        setRuntime(res.data)
      })
      .finally(() => setBusy(false))
  }

  return (
    <SettingsStack>
      <SettingsGroup title="Dictation">
        <SettingsField
          id="dictation-engine"
          title="Dictation engine"
          hint="OpenAI and OpenRouter use gpt-transcribe. Local (Whisper) runs ONNX on this machine. Qwen3-ASR connects to a local vLLM / qwen-asr-serve GPU server."
          help="Engine is read on each mic stop — no restart. Local stays disabled until at least one Whisper model is installed below. Qwen3-ASR needs a running local server (see below)."
        >
          <div className="flex w-full max-w-xs flex-col items-stretch gap-1.5">
            <Menu
              aria-label="Dictation engine"
              value={dictation.engine}
              options={engineOptions}
              searchable={false}
              placement="down"
              disabled={form.formLocked || busy || downloading}
              onChange={(v) => patchEngine(v as DictationEngine)}
            />
            <p className="m-0 text-xs text-secondary">
              {engineKeyHint(dictation.engine, secrets)}
            </p>
            {!localInstalled ? (
              <p className="m-0 text-xs text-muted">
                Install a Whisper model below to enable Local.
              </p>
            ) : null}
            {dictation.engine === 'local' && !localInstalled ? (
              <p className="m-0 text-xs text-danger" role="alert">
                Install a local Whisper model below, or switch engine.
              </p>
            ) : null}
          </div>
        </SettingsField>
        <SettingsField
          id="dictation-waveform"
          title="Waveform"
          hint="Listening visualizer in the composer."
          help="Applies the next time you open the composer after leaving Settings. Does not change transcription."
        >
          <Menu
            aria-label="Waveform"
            value={dictation.waveformStyle ?? 'bars'}
            options={DICTATION_WAVEFORM_STYLE_OPTIONS}
            searchable={false}
            placement="down"
            disabled={form.formLocked}
            onChange={(v) => patchWaveformStyle(v as DictationWaveformStyle)}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Local Whisper models">
        {WHISPER_MODELS.map((model) => {
          const inst = runtime?.installed.find((m) => m.id === model.id)
          const installed = inst != null
          const loaded = inst?.loaded === true
          const inUse = installed && dictation.localModelId === model.id
          const isRecommended = runtime?.recommendedModelId === model.id
          const statusLabel = cardStatusLabel(model.id, runtime)
          const fieldId =
            model.id === 'whisper-tiny.en'
              ? 'dictation-whisper-tiny'
              : 'dictation-whisper-small'
          return (
            <SettingsField
              key={model.id}
              id={fieldId}
              title={model.label}
              hint={`${model.roleLabel} · ${model.language} · ${model.approxDownloadLabel}`}
              help={`${model.ramHint}. Quantized q8 ONNX cached under app userData. Unload frees RAM; Delete cache removes the files.`}
              wide
            >
              <div className="flex w-full flex-col gap-2">
                <p className="m-0 text-xs text-secondary">
                  {statusLabel}
                  {installed && inst.bytesOnDisk > 0
                    ? ` · ${formatBytes(inst.bytesOnDisk)} on disk`
                    : ''}
                  {inUse ? ' · In use' : ''}
                  {isRecommended ? ' · Recommended for this PC' : ''}
                </p>
                <VoiceProgressBar status={runtime} modelId={model.id} />
                {runtime?.phase === 'error' && runtime.activeModelId === model.id && runtime.error ? (
                  <p className="m-0 text-xs text-danger" role="alert">
                    {runtime.error}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {!installed ? (
                    <Button
                      type="button"
                      variant="subtle"
                      disabled={form.formLocked || busy || downloading}
                      onClick={() =>
                        runModelAction(() => window.vyotiq.dictationInstall({ modelId: model.id }))
                      }
                    >
                      Install {model.label}
                    </Button>
                  ) : null}
                   {installed && !inUse ? (
                     <Button
                       type="button"
                       variant="subtle"
                       disabled={form.formLocked || busy || downloading || dictation.engine === 'qwen3-asr'}
                       onClick={() => patchLocalModelId(model.id)}
                     >
                       Use {model.label}
                     </Button>
                   ) : null}
                  {loaded ? (
                    <Button
                      type="button"
                      variant="subtle"
                      disabled={form.formLocked || busy || downloading}
                      onClick={() => runModelAction(() => window.vyotiq.dictationUnload())}
                    >
                      Unload {model.label}
                    </Button>
                  ) : null}
                  {installed ? (
                    <Button
                      type="button"
                      variant="danger"
                      disabled={form.formLocked || busy || downloading}
                      onClick={() =>
                        runModelAction(() =>
                          window.vyotiq.dictationDeleteCache({ modelId: model.id })
                        )
                      }
                    >
                      Delete {model.label} cache
                    </Button>
                  ) : null}
                </div>
              </div>
            </SettingsField>
          )
        })}
        {statusError ? (
          <p className="m-0 px-3 pb-3 text-xs text-danger" role="alert">
            {statusError}
          </p>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Qwen3-ASR (local server)">
        <SettingsField
          id="dictation-qwen3-server"
          title="Server URL"
          hint="OpenAI-compatible transcription base URL."
          help="Run `vllm serve Qwen/Qwen3-ASR-0.6B` (or `qwen-asr-serve`) and paste its base URL, e.g. http://127.0.0.1:8000/v1. The app POSTs `<url>/audio/transcriptions`; it does not download the model."
          wide
        >
          <Input
            type="url"
            aria-label="Qwen3-ASR server URL"
            placeholder="http://127.0.0.1:8000/v1"
            value={serverUrl}
            disabled={form.formLocked}
            onChange={(e) => setServerUrl(e.target.value)}
            onBlur={() => {
              if (serverUrl !== dictation.qwen3AsrServerUrl) patchServerUrl(serverUrl)
            }}
          />
        </SettingsField>
        <SettingsField
          id="dictation-qwen3-key"
          title="API key (optional)"
          hint="Bearer token for the server. Leave blank if the server has no auth."
          help="Only needed when vLLM / qwen-asr-serve was started with `--api-key`."
          wide
        >
          <Input
            type="password"
            aria-label="Qwen3-ASR server API key"
            placeholder="Optional"
            value={serverKey}
            disabled={form.formLocked}
            onChange={(e) => setServerKey(e.target.value)}
            onBlur={() => {
              if (serverKey !== dictation.qwen3AsrApiKey) patchServerKey(serverKey)
            }}
          />
        </SettingsField>
        {QWEN_MODELS.map((model) => {
          const inUse = dictation.localModelId === model.id
          return (
            <SettingsField
              key={model.id}
              id={`dictation-${model.id}`}
              title={model.label}
              hint={`${model.roleLabel} · ${model.language} · ${model.approxDownloadLabel}`}
              help={`${model.ramHint} Select a model, then start the matching server (served as ${model.hubRepo}).`}
              wide
            >
              <div className="flex w-full flex-col gap-2">
                <p className="m-0 text-xs text-secondary">
                  Served by your local GPU server
                  {inUse ? ' · In use' : ''}
                </p>
                <div className="flex flex-wrap gap-2">
                   {!inUse ? (
                     <Button
                       type="button"
                       variant="subtle"
                       disabled={form.formLocked || busy || dictation.engine === 'local'}
                       onClick={() => patchLocalModelId(model.id)}
                     >
                       Use {model.label}
                     </Button>
                   ) : (
                     <Button type="button" variant="subtle" disabled>
                       In use
                     </Button>
                   )}
                </div>
              </div>
            </SettingsField>
          )
        })}
      </SettingsGroup>
    </SettingsStack>
  )
}
