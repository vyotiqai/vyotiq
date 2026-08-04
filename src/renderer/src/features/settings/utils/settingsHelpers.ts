import { type McpServerStatus, type SecretProvider, type Settings } from '@shared/ipc'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'

export function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function workspaceShort(path: string | null): string {
  return formatWorkspaceName(path)
}

export function defaultKeyProvider(
  settingsProvider: Settings['provider'],
  _secrets: Record<SecretProvider, boolean>
): SecretProvider {
  return settingsProvider
}

export function mcpStatusLabel(
  status: McpServerStatus | undefined,
  opts?: { workspaceEnabled?: boolean }
): string {
  if (opts?.workspaceEnabled === false) {
    if (status?.connected) {
      const n = status.toolCount
      return `Force off here · connected globally · ${n} tool${n === 1 ? '' : 's'}`
    }
    return 'Force off in this workspace'
  }
  if (!status || !status.enabled) return 'Disabled'
  if (status.connected) {
    const n = status.toolCount
    return `Connected · ${n} tool${n === 1 ? '' : 's'}`
  }
  if (status.error) return 'Connection failed'
  return 'Not connected'
}

export function mcpStatusClass(
  status: McpServerStatus | undefined,
  opts?: { workspaceEnabled?: boolean }
): string {
  if (opts?.workspaceEnabled === false) return 'text-secondary'
  if (!status || !status.enabled) return 'text-secondary'
  if (status.connected) return 'text-success'
  if (status.error) return 'text-danger'
  return 'text-secondary'
}
