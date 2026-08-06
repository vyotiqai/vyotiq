import type { RunSummary } from '@shared/ipc'

/** First-line plain text from a run goal (strip common markdown chrome). */
export function stripGoalMarkdown(goal: string): string {
  let s = goal.trim().split(/\r?\n/, 1)[0] ?? ''
  s = s.replace(/^#{1,6}\s+/, '')
  s = s.replace(/\*\*(.+?)\*\*/g, '$1')
  s = s.replace(/__(.+?)__/g, '$1')
  s = s.replace(/\*(.+?)\*/g, '$1')
  s = s.replace(/_(.+?)_/g, '$1')
  s = s.replace(/`([^`]+)`/g, '$1')
  s = s.replace(/^>\s+/, '')
  s = s.replace(/^[-*+]\s*\[[ xX]\]\s+/, '')
  s = s.replace(/^[-*+]\s+/, '')
  s = s.replace(/^\d+\.\s+/, '')
  return s.replace(/\s+/g, ' ').trim()
}

export function runTitle(run: RunSummary): string {
  const goal = run.goal?.trim()
  if (!goal) return run.runId.slice(0, 8)
  // Full plain title — row CSS `truncate` + tooltip handle overflow (no dual cut).
  return stripGoalMarkdown(goal) || goal
}

export function runTooltip(run: RunSummary): string {
  const goal = run.goal?.trim()
  if (!goal) return run.runId
  return stripGoalMarkdown(goal) || goal
}

/** Lowercase plain text for sidebar search — matches displayed title, not raw goal. */
export function runSearchText(run: RunSummary): string {
  const goal = run.goal?.trim()
  if (!goal) return run.runId.toLowerCase()
  return (stripGoalMarkdown(goal) || goal).toLowerCase()
}
