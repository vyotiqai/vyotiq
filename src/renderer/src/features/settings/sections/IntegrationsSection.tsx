import { useEffect, useRef, useState } from 'react'
import { Input, Switch } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'

export function IntegrationsSection({ form }: { form: SettingsFormState }) {
  const persistedGithubClientId = form.settings.githubClientId ?? ''
  const [githubClientIdDraft, setGithubClientIdDraft] = useState(persistedGithubClientId)
  useEffect(() => {
    setGithubClientIdDraft(persistedGithubClientId)
  }, [persistedGithubClientId])

  const persistGithubClientId = (): void => {
    if (githubClientIdDraft === (form.settings.githubClientId ?? '')) return
    void form.runUpdate({ githubClientId: githubClientIdDraft })
  }
  const persistGithubClientIdRef = useRef(persistGithubClientId)
  persistGithubClientIdRef.current = persistGithubClientId
  useEffect(() => () => persistGithubClientIdRef.current(), [])

  return (
    <SettingsStack>
      <SettingsGroup title="GitHub">
        <SettingsField
          id="github-client-id"
          title="GitHub client ID"
          hint="OAuth / GitHub App client ID for Connect GitHub in the PR panel."
          help="Leave blank to use VYOTIQ_GITHUB_CLIENT_ID from the environment. Token is stored separately in secure storage."
          wide
        >
          <Input
            className="w-full"
            placeholder="Iv1… or OAuth app client id"
            aria-label="GitHub client ID"
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
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Harness">
        <SettingsField
          id="harness-rewriter"
          title="LLM harness proposal rewriter"
          hint="Experimental. Default off (rule-based notes only)."
          help="When on, /harness-review may rewrite the proposed default.md body via the configured model. Apply stays human-confirm + vitest gate."
        >
          <Switch
            size="md"
            checked={form.settings.harnessProposalRewriter ?? false}
            disabled={form.formLocked}
            label="LLM harness proposal rewriter"
            onCheckedChange={(checked) => {
              void form.runUpdate({ harnessProposalRewriter: checked })
            }}
          />
        </SettingsField>
      </SettingsGroup>
    </SettingsStack>
  )
}
