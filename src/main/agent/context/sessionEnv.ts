import os from 'node:os'
import type { AgentInteractionMode } from '../../../shared/ipc'
import { resolveTerminalShell } from '../tools/terminal'

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Local wall clock as YYYY-MM-DD HH:mm:ss (no locale month names). */
function formatLocalDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** Offset as UTC±HH:mm from the local timezone. */
function formatUtcOffset(d: Date): string {
  const offsetMin = -d.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
}

/**
 * Fresh per-step session block (UTC + local time/tz, OS, shell, mode).
 * Not workspace-cached — callers rebuild every agent step.
 */
export function buildSessionEnvSection(
  mode: AgentInteractionMode,
  terminalShellPref: string | undefined
): string {
  const now = new Date()
  const shell = resolveTerminalShell(
    (terminalShellPref as 'auto' | 'cmd' | 'powershell' | 'bash' | undefined) ?? 'auto'
  )
  const platform =
    process.platform === 'win32'
      ? 'Windows'
      : process.platform === 'darwin'
        ? 'macOS'
        : process.platform
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown'
  return [
    '## Session',
    `Date (UTC): ${now.toISOString()}`,
    `Date (local): ${formatLocalDateTime(now)} (${timeZone}, ${formatUtcOffset(now)})`,
    `OS: ${platform} (${process.platform} ${process.arch})`,
    `OS version: ${os.release()}`,
    `Terminal shell: ${shell}`,
    `Interaction mode: ${mode}`
  ].join('\n')
}
