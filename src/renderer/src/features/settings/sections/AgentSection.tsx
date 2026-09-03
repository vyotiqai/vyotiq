import { useEffect, useState } from 'react'
import type { ResponseVerbosity } from '@shared/ipc'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { Input, Menu, Switch } from '@renderer/lib/ui'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'
import { RESPONSE_VERBOSITY_OPTIONS } from '../constants'

export function AgentSection({ form }: { form: SettingsFormState }) {
  const showThinking =
    form.effectiveChatSettings?.showThinking ?? form.settings.showThinking

  const persistedPersona = form.effectiveChatSettings?.agentPersona ?? form.settings.agentPersona ?? ''
  const [personaDraft, setPersonaDraft] = useState(persistedPersona)
  useEffect(() => {
    setPersonaDraft(persistedPersona)
  }, [persistedPersona])
  const persistPersona = (): void => {
    if (personaDraft === persistedPersona) return
    void form.runAgentUpdate({ agentPersona: personaDraft })
  }

  const persistedTone = form.effectiveChatSettings?.agentTone ?? form.settings.agentTone ?? ''
  const [toneDraft, setToneDraft] = useState(persistedTone)
  useEffect(() => {
    setToneDraft(persistedTone)
  }, [persistedTone])
  const persistTone = (): void => {
    if (toneDraft === persistedTone) return
    void form.runAgentUpdate({ agentTone: toneDraft })
  }

  const persistedLanguage =
    form.effectiveChatSettings?.responseLanguage ?? form.settings.responseLanguage ?? ''
  const [languageDraft, setLanguageDraft] = useState(persistedLanguage)
  useEffect(() => {
    setLanguageDraft(persistedLanguage)
  }, [persistedLanguage])
  const persistLanguage = (): void => {
    if (languageDraft === persistedLanguage) return
    void form.runAgentUpdate({ responseLanguage: languageDraft })
  }

  return (
    <SettingsStack>
      {form.workspaceOverrideActive ? (
        <p className="m-0 rounded-xl bg-surface px-4 py-3 text-xs text-secondary">
          Workspace override on — persona &amp; style, show thinking, and keep recent turns apply
          to this workspace only. Tool approval (Settings → Tools) also honors this override.
          Shell, search engine, browser domain allowlist, and automatic mode switching stay
          app-wide.
        </p>
      ) : null}

      <SettingsGroup title="Chat">
        <SettingsField
          id="show-thinking"
          title="Show thinking in chat"
          hint="Collapsed thinking blocks above assistant replies."
          help={
            form.workspaceOverrideActive
              ? 'With workspace override on, this applies to the active workspace only.'
              : 'Shown when the model returns reasoning content.'
          }
        >
          <Switch
            size="md"
            checked={showThinking}
            disabled={form.formLocked}
            label={
              form.workspaceOverrideActive
                ? 'Show thinking in chat for this workspace'
                : 'Show thinking in chat'
            }
            onCheckedChange={(checked) => {
              void form.runAgentUpdate({ showThinking: checked })
            }}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Persona & style">
        <SettingsField
          id="agent-persona"
          title="Persona"
          hint="Assistant identity the agent claims in replies."
          help={
            form.workspaceOverrideActive
              ? 'With workspace override on, this applies to the active workspace only.'
              : 'Leave blank to keep the default Agent V identity. Per-workspace via Workspace Override.'
          }
          wide
        >
          <div className="flex w-full flex-col gap-1.5">
            <Input
              className="w-full"
              placeholder="e.g. Nova — a terse, senior pair programmer"
              aria-label="Persona"
              maxLength={1000}
              disabled={form.formLocked}
              value={personaDraft}
              key={`agent-persona-${form.workspaceOverrideActive}`}
              onChange={(e) => {
                setPersonaDraft(e.target.value)
              }}
              onBlur={() => {
                persistPersona()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
            />
            <div className="text-right text-2xs tabular-nums text-muted">
              {personaDraft.length}/1000
            </div>
          </div>
        </SettingsField>

        <SettingsField
          id="agent-tone"
          title="Tone"
          hint="How replies sound — free-form description."
          help={
            form.workspaceOverrideActive
              ? 'With workspace override on, this applies to the active workspace only.'
              : 'Examples: friendly, blunt, playful, formal. Leave blank for the default tone.'
          }
          wide
        >
          <div className="flex w-full flex-col gap-1.5">
            <Input
              className="w-full"
              placeholder="Friendly, direct, playful…"
              aria-label="Tone"
              maxLength={2000}
              disabled={form.formLocked}
              value={toneDraft}
              key={`agent-tone-${form.workspaceOverrideActive}`}
              onChange={(e) => {
                setToneDraft(e.target.value)
              }}
              onBlur={() => {
                persistTone()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
            />
            <div className="text-right text-2xs tabular-nums text-muted">
              {toneDraft.length}/2000
            </div>
          </div>
        </SettingsField>

        <SettingsField
          id="response-language"
          title="Response language"
          hint="Preferred language for replies."
          help={
            form.workspaceOverrideActive
              ? 'With workspace override on, this applies to the active workspace only.'
              : "Leave blank to follow your language."
          }
        >
          <Input
            className="w-full sm:w-64"
            placeholder="e.g. Spanish, 日本語, Deutsch"
            aria-label="Response language"
            maxLength={64}
            disabled={form.formLocked}
            value={languageDraft}
            key={`response-language-${form.workspaceOverrideActive}`}
            onChange={(e) => {
              setLanguageDraft(e.target.value)
            }}
            onBlur={() => {
              persistLanguage()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(e.target as HTMLInputElement).blur()
              }
            }}
          />
        </SettingsField>

        <SettingsField
          id="response-verbosity"
          title="Answer length"
          hint="Default length for conversational replies."
          help={
            form.workspaceOverrideActive
              ? 'With workspace override on, this applies to the active workspace only.'
              : 'Concise is the default; code and task output is unaffected.'
          }
        >
          <Menu
            aria-label="Answer length"
            value={
              form.effectiveChatSettings?.responseVerbosity ??
              form.settings.responseVerbosity ??
              'concise'
            }
            options={RESPONSE_VERBOSITY_OPTIONS}
            searchable={false}
            placement="down"
            disabled={form.formLocked}
            onChange={(v) => {
              void form.runAgentUpdate({ responseVerbosity: v as ResponseVerbosity })
            }}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Compaction">
        <SettingsField
          id="keep-recent-turns"
          title="Keep recent turns"
          hint="Turns preserved during compaction (4–50)."
          help="Compaction keeps this many recent conversation turns when context is trimmed."
        >
          <div className="flex items-center gap-1.5">
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
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  e.currentTarget.blur()
                }
              }}
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
            <span className="text-xs text-secondary">turns</span>
          </div>
          {form.fieldError.keepTurns}
        </SettingsField>

        <SettingsField
          id="auto-compact-threshold"
          title="Auto-compact threshold"
          hint="Percent of the model content window that triggers auto-compact (5–95)."
          help="When estimated context reaches this share of the content window, the loop runs the same summarizer as Compact in the context meter."
        >
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              className="w-24"
              aria-label="Auto-compact threshold percent"
              min={5}
              max={95}
              disabled={form.formLocked}
              defaultValue={form.agentAutoCompactThresholdPct}
              key={`auto-compact-${form.agentAutoCompactThresholdPct}-${form.workspaceOverrideActive}`}
              aria-invalid={form.errorField === 'autoCompactThreshold' ? true : undefined}
              aria-describedby={
                form.errorField === 'autoCompactThreshold' ? 'auto-compact-threshold-error' : undefined
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  e.currentTarget.blur()
                }
              }}
              onBlur={(e) => {
                form.commitNumberField('autoCompactThreshold', e.target, {
                  label: 'Auto-compact threshold',
                  min: 5,
                  max: 95,
                  integer: true,
                  current: form.agentAutoCompactThresholdPct,
                  apply: (pct) => ({ autoCompactThresholdRatio: pct / 100 }),
                  persist: (partial) => {
                    void form.runAgentUpdate(partial)
                  }
                })
              }}
            />
            <span className="text-xs text-secondary">%</span>
          </div>
          {form.fieldError.autoCompactThreshold}
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Reference">
        <SettingsField
          id="workspace-rules"
          title="Workspace rules"
          hint="Loaded from AGENTS.md, CLAUDE.md, .cursorrules, and .vyotiq/rules/."
          help="Create and edit user and project rules in Marketplace → Manage → Rules. Rules with alwaysApply: false stay requestable (slash) and are not auto-injected."
          wide
        >
          <p className="m-0 text-xs text-secondary">
            Open Marketplace → Manage → Rules, or use <code className="text-caption">/create-rule</code> in
            chat.
          </p>
        </SettingsField>

        <SettingsField
          id="memory-files"
          title="Memory files"
          hint="Long-term memory under .vyotiq/memory/ (plain markdown)."
          help="Use memory_* tools in Agent mode for durable facts. Not embedding RAG — facts are markdown files in the workspace. Use codebase_search for semantic code retrieval (local LightOn dense ONNX index in app userData; Ollama/hash overrides)."
          wide
        >
          <p className="m-0 text-xs text-secondary">index.md, state.md, and notes/ in the workspace.</p>
        </SettingsField>
      </SettingsGroup>
    </SettingsStack>
  )
}
