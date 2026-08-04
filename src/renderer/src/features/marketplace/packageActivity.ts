import type {
  MarketplaceCatalogEntry,
  MarketplaceInstalledItem,
  McpServerStatus
} from '@shared/ipc'
import { kindLabel } from './marketplaceLabels'

export type PackageActivityKind =
  | 'coming-soon'
  | 'connected'
  | 'enabled'
  | 'connect-failed'
  | 'disabled'
  | 'installed'
  | 'available'

export type PackageActivity = {
  kind: PackageActivityKind
  /** Short label for card footers / buttons */
  label: string
  /** Optional success/danger tint class for the label */
  className?: string
}

export type PackageActivityOptions = {
  /** Workspace Force on/off for this package (MCP / skill / plugin id). */
  workspaceEnabled?: boolean
  /** Nested MCP connection status for plugin packages. */
  nestedMcpStatuses?: Array<McpServerStatus | undefined>
}

export function packageActivity(
  entry: MarketplaceCatalogEntry,
  installed: MarketplaceInstalledItem | undefined,
  mcpStatus: McpServerStatus | undefined,
  options?: PackageActivityOptions
): PackageActivity {
  if (entry.installable === false) {
    return { kind: 'coming-soon', label: 'Coming soon' }
  }
  if (!installed) {
    return { kind: 'available', label: kindLabel(entry.kind) }
  }
  if (options?.workspaceEnabled === false) {
    return { kind: 'disabled', label: 'Force off here' }
  }
  if (!installed.enabled) {
    return { kind: 'disabled', label: 'Disabled' }
  }
  if (entry.kind === 'mcp') {
    if (mcpStatus?.connected) {
      const n = mcpStatus.toolCount
      return {
        kind: 'connected',
        label: `Connected · ${n} tool${n === 1 ? '' : 's'}`,
        className: 'text-success'
      }
    }
    if (mcpStatus?.error) {
      const short =
        mcpStatus.error.length > 72
          ? `${mcpStatus.error.slice(0, 69)}…`
          : mcpStatus.error
      return {
        kind: 'connect-failed',
        label: `Connect failed · ${short}`,
        className: 'text-danger'
      }
    }
    return { kind: 'enabled', label: 'Enabled' }
  }
  if (entry.kind === 'plugin' && options?.nestedMcpStatuses?.length) {
    const statuses = options.nestedMcpStatuses.filter(
      (s): s is McpServerStatus => s != null
    )
    if (statuses.length > 0) {
      const connected = statuses.filter((s) => s.connected)
      const tools = connected.reduce((sum, s) => sum + s.toolCount, 0)
      if (connected.length === statuses.length) {
        return {
          kind: 'connected',
          label: `Connected · ${tools} tool${tools === 1 ? '' : 's'}`,
          className: 'text-success'
        }
      }
      if (connected.length > 0) {
        return {
          kind: 'enabled',
          label: `${connected.length}/${statuses.length} MCP connected`,
          className: 'text-success'
        }
      }
      const failed = statuses.find((s) => s.error?.trim())
      if (failed?.error) {
        const short =
          failed.error.length > 72
            ? `${failed.error.slice(0, 69)}…`
            : failed.error
        return {
          kind: 'connect-failed',
          label: `Connect failed · ${short}`,
          className: 'text-danger'
        }
      }
    }
  }
  return { kind: 'enabled', label: 'Enabled' }
}

/** Featured / detail trailing button label when installed. */
export function installedActionLabel(activity: PackageActivity): string {
  switch (activity.kind) {
    case 'connected':
      return 'Connected'
    case 'enabled':
      return 'Enabled'
    case 'connect-failed':
      return 'Connect failed'
    case 'disabled':
      return 'Disabled'
    case 'installed':
    case 'coming-soon':
    case 'available':
      return 'Installed'
    default: {
      const _exhaustive: never = activity.kind
      return _exhaustive
    }
  }
}
