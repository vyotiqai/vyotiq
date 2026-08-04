import { PROVIDER_DEFAULTS } from '@shared/providers'

export const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' }
]

export const TOOL_APPROVAL_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'mutating', label: 'Ask for edits and commands' },
  { value: 'all', label: 'Ask for every tool' }
]

export const TERMINAL_SHELL_OPTIONS = [
  { value: 'auto', label: 'Auto (PowerShell on Windows when available)' },
  { value: 'cmd', label: 'Windows cmd.exe' },
  { value: 'powershell', label: 'PowerShell' },
  { value: 'bash', label: 'Bash' }
]

export const ACTIVE_PROVIDER_OPTIONS = PROVIDER_DEFAULTS.map((p) => ({
  value: p.id,
  label: p.label
}))

export const SECTION_LABELS: Record<
  'general' | 'providers' | 'agent' | 'marketplace',
  { title: string; description?: string }
> = {
  general: {
    title: 'General',
    description: 'Model display, workspaces, appearance, and diagnostics.'
  },
  providers: {
    title: 'Providers',
    description: 'Active provider, API keys, and model catalog refresh.'
  },
  agent: {
    title: 'Agent',
    description: 'Compaction, memory, and approval settings.'
  },
  marketplace: {
    title: 'Registry',
    description: 'Optional package registry URL and remote-install acknowledgement.'
  }
}
