import { useEffect, useState } from 'react'
import type { ImageProviderSetting, TerminalShell, ToolApprovalMode } from '@shared/ipc'
import { providerNeedsKey } from '@shared/providers'
import { Input, Menu, Button } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { TERMINAL_SHELL_OPTIONS, TOOL_APPROVAL_OPTIONS } from '../constants'
import { SettingsRow } from '../components/SettingsRow'

const IMAGE_PROVIDER_OPTIONS: { value: ImageProviderSetting; label: string }[] = [
  { value: 'auto', label: 'Auto (first available key)' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'xai', label: 'xAI' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'custom', label: 'Custom OpenAI host' }
]

export function AgentSection({ form }: { form: SettingsFormState }) {

  const persistedDiagnostics = form.settings.diagnosticsCommand ?? ''
  const [diagnosticsDraft, setDiagnosticsDraft] = useState(persistedDiagnostics)
  useEffect(() => {
    setDiagnosticsDraft(persistedDiagnostics)
  }, [persistedDiagnostics])

  const persistDiagnostics = (): void => {
    if (diagnosticsDraft === (form.settings.diagnosticsCommand ?? '')) return
    void form.runUpdate({ diagnosticsCommand: diagnosticsDraft })
  }

  const persistedGithubClientId = form.settings.githubClientId ?? ''
  const [githubClientIdDraft, setGithubClientIdDraft] = useState(persistedGithubClientId)
  useEffect(() => {
    setGithubClientIdDraft(persistedGithubClientId)
  }, [persistedGithubClientId])

  const persistGithubClientId = (): void => {
    if (githubClientIdDraft === (form.settings.githubClientId ?? '')) return
    void form.runUpdate({ githubClientId: githubClientIdDraft })
  }

  const imageReadyProviders = (['openai', 'gemini', 'xai', 'openrouter', 'custom'] as const).filter(
    (id) => {
      if (id === 'custom') {
        if (!form.settings.customImageEnabled) return false
        if (form.savedKeyProviders.includes('custom')) return true
        return !providerNeedsKey(
          'custom',
          form.effectiveChatSettings?.customOpenAiBaseUrl ?? form.settings.customOpenAiBaseUrl
        )
      }
      return form.savedKeyProviders.includes(id)
    }
  )
  const labelForImage = (id: (typeof imageReadyProviders)[number]): string => {
    if (id === 'openai') return 'OpenAI'
    if (id === 'gemini') return 'Gemini'
    if (id === 'xai') return 'xAI'
    if (id === 'openrouter') return 'OpenRouter'
    return 'Custom'
  }
  const imageReadyLabel =
    imageReadyProviders.length > 0
      ? `Image ready: ${imageReadyProviders.map(labelForImage).join(', ')}.`
      : 'Image ready: none — add an OpenAI, Gemini, xAI, or OpenRouter key (or enable custom host images on a keyed or private/LAN URL).'
  const imageProviderDescription = `${imageReadyLabel} Auto picks OpenAI → Gemini → xAI → OpenRouter → custom (if enabled) by key. Chat Completions on a custom host does not imply Images API support.`

  return (
    <>
      {form.workspaceOverrideActive ? (
        <p className="m-0 mb-3 rounded-md border border-border bg-surface px-2.5 py-2 text-xs text-secondary">
          Workspace override is on — compaction, thinking, and approval fields apply
          to this workspace only. Rows marked Global setting still update app-wide
          settings.
        </p>
      ) : null}

      <SettingsRow
        title="Show thinking in chat"
        description={
          form.workspaceOverrideActive
            ? 'Collapsed thinking blocks above assistant replies. With workspace override on, this applies to the active workspace only.'
            : 'Collapsed thinking blocks above assistant replies when the model returns reasoning.'
        }
      >
        <label className="inline-flex items-center gap-2 text-xs text-secondary">
          <input
            type="checkbox"
            className="size-3.5 accent-fg"
            aria-label={
              form.workspaceOverrideActive
                ? 'Show thinking in chat for this workspace'
                : 'Show thinking in chat'
            }
            disabled={form.formLocked}
            checked={
              form.effectiveChatSettings?.showThinking ?? form.settings.showThinking
            }
            onChange={(e) => {
              void form.runAgentUpdate({ showThinking: e.target.checked })
            }}
          />
          {(form.effectiveChatSettings?.showThinking ?? form.settings.showThinking)
            ? form.workspaceOverrideActive
              ? 'On (this workspace)'
              : 'On'
            : form.workspaceOverrideActive
              ? 'Off (this workspace)'
              : 'Off'}
        </label>
      </SettingsRow>

      <SettingsRow
        title="Compaction trigger"
        description="Context usage ratio that triggers compaction (0.5–0.95)."
      >
        <Input
          type="number"
          className="w-24"
          aria-label="Compaction trigger ratio"
          min={0.5}
          max={0.95}
          step={0.05}
          disabled={form.formLocked}
          defaultValue={form.agentCompactionTriggerRatio}
          key={`compaction-${form.agentCompactionTriggerRatio}-${form.workspaceOverrideActive}`}
          aria-invalid={form.errorField === 'compaction' ? true : undefined}
          aria-describedby={form.errorField === 'compaction' ? 'compaction-error' : undefined}
          onBlur={(e) => {
            form.commitNumberField('compaction', e.target, {
              label: 'Compaction trigger ratio',
              min: 0.5,
              max: 0.95,
              current: form.agentCompactionTriggerRatio,
              apply: (compactionTriggerRatio) => ({ compactionTriggerRatio }),
              persist: (partial) => {
                void form.runAgentUpdate(partial)
              }
            })
          }}
        />
        {form.fieldError.compaction}
      </SettingsRow>

      <SettingsRow
        title="Keep recent turns"
        description="Recent conversation turns preserved during compaction (4–50)."
      >
        <Input
          type="number"
          className="w-24"
          aria-label="Keep recent turns"
          min={4}
          max={50}
          disabled={form.formLocked}
          defaultValue={form.agentKeepRecentTurns}
          key={`keep-turns-${form.agentKeepRecentTurns}-${form.workspaceOverrideActive}`}
          aria-invalid={form.errorField === 'keepTurns' ? true : undefined}
          aria-describedby={form.errorField === 'keepTurns' ? 'keep-turns-error' : undefined}
          onBlur={(e) => {
            form.commitNumberField('keepTurns', e.target, {
              label: 'Keep recent turns',
              min: 4,
              max: 50,
              integer: true,
              current: form.agentKeepRecentTurns,
              apply: (keepRecentTurns) => ({ keepRecentTurns }),
              persist: (partial) => {
                void form.runAgentUpdate(partial)
              }
            })
          }}
        />
        {form.fieldError.keepTurns}
      </SettingsRow>

      <SettingsRow
        title="Image provider"
        description={imageProviderDescription}
      >
        <Menu
          aria-label="Image provider"
          value={form.settings.imageProvider ?? 'auto'}
          options={IMAGE_PROVIDER_OPTIONS}
          searchable={false}
          placement="down"
          disabled={form.formLocked}
          onChange={(v) => {
            void form.runUpdate({ imageProvider: v as ImageProviderSetting })
          }}
        />
      </SettingsRow>

      <SettingsRow
        title="Image model"
        description="Optional default for generate_image / edit_image. Blank uses gpt-image-2, gemini-3.1-flash-image (or set gemini-3-pro-image), grok-imagine-image-quality (use grok-imagine-image for speed), bytedance-seed/seedream-4.5 on OpenRouter, or dall-e-3 on custom hosts."
      >
        <Input
          className="w-[240px] max-w-[46vw]"
          aria-label="Image model"
          placeholder="Provider default"
          disabled={form.formLocked}
          defaultValue={form.settings.imageModel ?? ''}
          key={`image-model-${form.settings.imageModel ?? ''}`}
          onBlur={(e) => {
            const raw = e.target.value.trim()
            void form.runUpdate({ imageModel: raw })
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
      </SettingsRow>

      <SettingsRow
        title="Enable image generation on custom host"
        description="Off by default. Chat Completions on Custom OpenAI base URL does not imply /v1/images/generations. When on, VYOTIQ probes the host (empty POST → 404/501 = unsupported) before generate_image. Private/LAN hosts stay key-optional (same as chat); public hosts need a Custom API key. Set Image model to a model your host actually serves."
      >
        <label className="inline-flex items-center gap-2 text-xs text-secondary">
          <input
            type="checkbox"
            className="size-3.5 accent-fg"
            aria-label="Enable image generation on custom host"
            disabled={form.formLocked}
            checked={Boolean(form.settings.customImageEnabled)}
            onChange={(e) => {
              void form.runUpdate({ customImageEnabled: e.target.checked })
            }}
          />
          {form.settings.customImageEnabled ? 'On' : 'Off'}
        </label>
      </SettingsRow>

      <SettingsRow
        title="Tool approval"
        description="Ask before the agent runs tools. Off by default; allowlisted tools never ask."
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Menu
              aria-label="Tool approval"
              value={form.toolApproval.mode}
              options={TOOL_APPROVAL_OPTIONS}
              searchable={false}
              placement="down"
              disabled={form.formLocked}
              onChange={(v) => {
                void form.runAgentUpdate({
                  toolApproval: { ...form.toolApproval, mode: v as ToolApprovalMode }
                })
              }}
            />
            {form.toolApproval.allowlist.length > 0 ? (
              <Button
                variant="subtle"
                disabled={form.formLocked}
                onClick={() => {
                  void form.runAgentUpdate({
                    toolApproval: { ...form.toolApproval, allowlist: [] }
                  })
                }}
              >
                Clear {form.toolApproval.allowlist.length} allowed
              </Button>
            ) : null}
          </div>
          {form.toolApproval.allowlist.length > 0 ? (
            <ul className="m-0 list-inside list-disc pl-1 text-xs text-tertiary">
              {form.toolApproval.allowlist.map((name) => (
                <li key={name} className="font-mono">
                  {name}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </SettingsRow>

      <SettingsRow
        title="Terminal shell"
        description="Shell for the terminal tool. Auto prefers PowerShell on Windows when available. Global setting (not per-workspace)."
      >
        <Menu
          aria-label="Terminal shell"
          value={form.settings.terminalShell ?? 'auto'}
          options={TERMINAL_SHELL_OPTIONS}
          searchable={false}
          placement="down"
          disabled={form.formLocked}
          onChange={(v) => {
            void form.runUpdate({ terminalShell: v as TerminalShell })
          }}
        />
      </SettingsRow>

      <SettingsRow
        title="Diagnostics command"
        description="Optional override for the diagnostics tool typecheck. Leave blank to auto-detect (package scripts or tsc). Global setting."
      >
        <Input
          className="w-full max-w-md"
          placeholder="e.g. pnpm typecheck"
          disabled={form.formLocked}
          value={diagnosticsDraft}
          onChange={(e) => {
            setDiagnosticsDraft(e.target.value)
          }}
          onBlur={() => {
            persistDiagnostics()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
      </SettingsRow>

      <SettingsRow
        title="Automatic mode switching"
        description="When on, the agent may call switch_mode mid-run as the task moves between investigate, plan, and implement. When off, only you change mode (composer picker or slash). Default off. Global setting."
      >
        <label className="inline-flex items-center gap-2 text-xs text-secondary">
          <input
            type="checkbox"
            className="size-3.5 accent-fg"
            aria-label="Automatic mode switching"
            disabled={form.formLocked}
            checked={form.settings.autoModeSwitch ?? false}
            onChange={(e) => {
              void form.runUpdate({ autoModeSwitch: e.target.checked })
            }}
          />
          {form.settings.autoModeSwitch ? 'On' : 'Off'}
        </label>
      </SettingsRow>

      <SettingsRow
        stacked
        title="GitHub client ID"
        description="OAuth / GitHub App client ID for in-app Connect GitHub (device flow) in the PR panel. Leave blank to use VYOTIQ_GITHUB_CLIENT_ID from the environment. Global setting."
      >
        <Input
          className="w-full max-w-md"
          placeholder="Iv1… or OAuth app client id"
          disabled={form.formLocked}
          value={githubClientIdDraft}
          onChange={(e) => {
            setGithubClientIdDraft(e.target.value)
          }}
          onBlur={() => {
            persistGithubClientId()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
      </SettingsRow>

      <SettingsRow
        title="LLM harness proposal rewriter"
        description="Experimental. When on, /harness-review may rewrite the proposed default.md body via the configured model. Apply stays human-confirm + vitest gate. Default off (rule-based notes only). Global setting."
      >
        <label className="inline-flex items-center gap-2 text-xs text-secondary">
          <input
            type="checkbox"
            className="size-3.5 accent-fg"
            aria-label="LLM harness proposal rewriter"
            disabled={form.formLocked}
            checked={form.settings.harnessProposalRewriter ?? false}
            onChange={(e) => {
              void form.runUpdate({ harnessProposalRewriter: e.target.checked })
            }}
          />
          Enable experimental rewriter
        </label>
      </SettingsRow>

      <SettingsRow
        stacked
        title="Workspace rules"
        description="Loaded from AGENTS.md, CLAUDE.md, .cursorrules, .cursor/rules/, and .vyotiq/rules/. File-backed — edit on disk or create via /create-rule in chat."
      >
        <p className="m-0 text-xs text-secondary">
          Rules with <code className="text-[11px]">alwaysApply: false</code> stay
          requestable (slash) and are not auto-injected.
        </p>
      </SettingsRow>

      <SettingsRow
        stacked
        title="Memory files"
        description="Long-term memory lives under .vyotiq/memory/ (index.md, state.md, notes/). Use memory_* tools in Agent mode when you want durable facts."
      >
        <p className="m-0 text-xs text-secondary">
          Memory is not embedding RAG — durable facts are plain markdown files in the
          workspace.
        </p>
      </SettingsRow>
    </>
  )
}
