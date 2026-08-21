import type { SettingsFormState } from '../hooks/useSettingsForm'
import { Input, Switch } from '@renderer/lib/ui'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'

export function AgentSection({ form }: { form: SettingsFormState }) {
  const showThinking =
    form.effectiveChatSettings?.showThinking ?? form.settings.showThinking

  return (
    <SettingsStack>
      {form.workspaceOverrideActive ? (
        <p className="m-0 rounded-xl bg-surface px-4 py-3 text-xs text-secondary">
          Workspace override on — show thinking and keep recent turns apply to this
          workspace only. Tool approval (Settings → Tools) also honors this override.
          Integrations and other Tools rows (shell, search, auto mode) stay app-wide.
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
