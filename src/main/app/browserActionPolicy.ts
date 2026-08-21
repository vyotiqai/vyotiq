/**
 * Action policy stubs for future high-risk browser capabilities.
 *
 * Not yet implemented as agent tools. When added, gate them here and in
 * modePolicy / approval settings before enabling.
 *
 * | Action   | Default | Notes |
 * |----------|---------|-------|
 * | upload   | deny    | Workspace-scoped path + explicit user approval |
 * | download | deny    | Save under run/workspace only; confirm large/binary |
 * | eval     | deny    | Never expose free-form JS eval to the model |
 * | dialog   | allow   | Agent-only accept/dismiss via browser_handle_dialog |
 *
 * See docs/reference/2026-jun-aug/07-browser-tools.md § Action policy.
 */

export type BrowserFutureAction = 'upload' | 'download' | 'eval'

export type BrowserActionDecision = {
  allowed: boolean
  reason: string
}

/** Future gate — currently always denies upload/download/eval. */
export function assertBrowserActionAllowed(action: BrowserFutureAction): BrowserActionDecision {
  switch (action) {
    case 'upload':
      return {
        allowed: false,
        reason: 'browser file upload is not implemented (default deny)'
      }
    case 'download':
      return {
        allowed: false,
        reason: 'browser download is not implemented (default deny)'
      }
    case 'eval':
      return {
        allowed: false,
        reason: 'browser JS eval is denied by policy'
      }
    default: {
      const _exhaustive: never = action
      return _exhaustive
    }
  }
}
