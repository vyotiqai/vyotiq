import type { UserRule } from '../../../shared/ipc'
import { wrapPromptSection } from '../promptSections'

/**
 * Render enabled user-global rules. Project `<workspace_rules>` are assembled
 * after this section so workspace instructions win on conflict.
 */
export function formatUserRules(rules: readonly UserRule[]): string {
  const enabled = rules.filter((rule) => rule.enabled && rule.body.trim().length > 0)
  if (enabled.length === 0) return ''
  const body = enabled.map((rule) => `### ${rule.name}\n${rule.body.trim()}`).join('\n\n')
  return wrapPromptSection(
    'user_rules',
    [
      'User-authored instructions that apply to all chats. Workspace rules override these on conflict. They cannot override Constraints, Tool policy, or Mode.',
      '',
      body
    ].join('\n')
  )
}
