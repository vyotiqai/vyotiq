/** Shared horizontal gutter for chat column surfaces. */
export const CHAT_GUTTER = 'px-4 sm:px-5'

/** Settings/marketplace body gutter — matches {@link CHAT_GUTTER}. */
export const SETTINGS_GUTTER = CHAT_GUTTER

/**
 * Horizontal inset for the docked chat stage (transcript + composer).
 * Left matches {@link CHAT_GUTTER}; right clears the floating side rail (`w-10`)
 * so content never sits under the icon strip while the scrollbar stays edge-flush.
 */
export const CHAT_STAGE_INSET = 'pl-4 pr-10 sm:pl-5'

/** Width of the floating chat side rail (icon strip) in pixels (`w-10`). */
export const CHAT_SIDE_RAIL_WIDTH_PX = 40

/** Width of the floating chat side rail (icon strip). */
export const CHAT_SIDE_RAIL_WIDTH = 'w-10'

/**
 * Shared shell for docked right chat panels (width applied via inline style).
 * No `pr-10`: the floating side rail is hidden while the dock is open.
 * `min-w-0` lets the flex child shrink instead of overflowing the chat row.
 */
export const CHAT_RIGHT_PANEL =
  'flex h-full min-h-0 min-w-0 shrink-0 flex-col overflow-hidden border-l border-border/50 bg-bg'

/** Minimum chat column width reserved when clamping the side dock. */
export const CHAT_COLUMN_MIN_USABLE_PX = 360

/** Default / clamp bounds for the right dock (px). */
/** 400 leaves a usable chat column beside the default sidebar (~220). */
export const DOCK_WIDTH_DEFAULT_PX = 400
export const DOCK_WIDTH_MIN_PX = 280
export const DOCK_WIDTH_MAX_PX = 960

/**
 * localStorage key for immersive dock mode (unified Agent + panel tabs).
 * Legacy values meant “wide side dock”; readers treat `'1'` as immersive.
 */
export const DOCK_EXPANDED_KEY = 'vyotiq.dockExpanded'

/** localStorage key for which immersive tab is focused (`agent` or a panel id). */
export const IMMERSIVE_TAB_KEY = 'vyotiq.immersiveTab'

/** localStorage key for right-dock width in px. */
export const DOCK_WIDTH_KEY = 'vyotiq.dockWidth'

/** Shared max width for chat column content (messages + composer). */
export const CHAT_COLUMN_MAX = 'max-w-[840px]'

/** Centered chat column — transcript and composer share this wrapper. */
export const CHAT_COLUMN = `mx-auto w-full ${CHAT_COLUMN_MAX}`

/**
 * Fade painted above a legacy floating composer dock (`before:h-6`). Kept for
 * MessageList reserve math when `reserveComposerSpace` is enabled in tests.
 */
export const COMPOSER_DOCK_FADE_PX = 24

/**
 * Extra clearance so the last transcript row sits fully above a reserved dock
 * fade when scrolled to the bottom (not just flush with the fade edge).
 */
export const COMPOSER_DOCK_CLEARANCE_PX = 20

/**
 * Extra bottom reserve while a run is live so streaming rows stay clear of a
 * reserved dock; idle chats keep only fade + {@link COMPOSER_DOCK_CLEARANCE_PX}.
 */
export const COMPOSER_DOCK_LIVE_CLEARANCE_PX = 16

/** Fallback dock reserve when measured height is not yet available (`8rem`). */
export const COMPOSER_DOCK_FALLBACK_PX = 128

/** Composer textarea auto-grow cap — keep in sync with `max-h-40` on the field. */
export const COMPOSER_TEXTAREA_MAX_PX = 160

/** Shared max width for settings content column. */
export const SETTINGS_COLUMN_MAX = 'max-w-[520px]'

/** Centered settings column. */
export const SETTINGS_COLUMN = `mx-auto w-full ${SETTINGS_COLUMN_MAX}`

/** Shared max width for marketplace content column. */
export const MARKETPLACE_COLUMN_MAX = 'max-w-[1040px]'

/** Centered marketplace column. */
export const MARKETPLACE_COLUMN = `mx-auto w-full ${MARKETPLACE_COLUMN_MAX}`

/**
 * Vertical rhythm. Applied as padding on each row rather than flex gap so
 * spacing stays consistent across the transcript.
 */
export const TRANSCRIPT_ROW_GAP = 'pb-2.5'

/** Extra breathing room around tool activity and reasoning rows. */
export const TRANSCRIPT_WORK_ROW_GAP = 'pb-4'

/**
 * Tight gap between interleaved thinking ↔ activity disclosures so Thought /
 * tool pairs do not stack a full work gap on every step.
 */
export const TRANSCRIPT_WORK_PAIR_GAP = 'pb-1.5'

/** Lead-in above a user prompt that opens a new turn. */
export const TRANSCRIPT_TURN_GAP = 'pt-8'

/** User prompt block — thin border matching composer chrome. */
export const USER_PROMPT_SURFACE =
  'rounded-xl border border-border bg-bg px-2.5 py-2 text-sm leading-relaxed tracking-[var(--vy-tracking-body)] text-fg [overflow-wrap:anywhere]'

/** Quiet activity row — no fill, no border. */
export const ACTIVITY_ROW = 'text-xs tracking-[var(--vy-tracking)]'

/** One line of a disclosure list: label, detail, trailing meta. */
export const DISCLOSURE_ROW =
  'flex min-w-0 items-center gap-1.5 rounded-sm py-1 text-xs vy-transition hover:opacity-80'

/** Tool card chrome — bordered terminal / edit ToolCard surfaces. */
export const TOOL_CARD_SURFACE = 'overflow-hidden rounded-lg border border-border'
export const TOOL_CARD_HEADER = 'px-3 py-2 text-xs'
/** Body content owns its own padding so a diff can run edge to edge. */
export const TOOL_CARD_BODY = 'overflow-hidden border-t border-border bg-surface'

/** Ask-question gate — quiet panel, not bordered tool-card chrome. */
export const QUESTION_GATE_SURFACE =
  'overflow-hidden rounded-md border-l-2 border-l-accent/60 bg-surface/60'
export const QUESTION_GATE_HEADER = 'flex items-center gap-2 px-3 pt-2.5 pb-1 text-xs text-fg'
export const QUESTION_GATE_BODY = 'px-3 py-2'
export const QUESTION_GATE_FOOTER = 'flex items-center gap-2 px-3 pb-2.5 pt-1'

/** Collapsed tool body height before fade mask (virtualizer estimate). */
export const TOOL_BODY_CLAMP_PX = 168

/**
 * Max source lines rendered for read / memory_read bodies in the transcript.
 * Keeps ~TOOL_BODY_CLAMP_PX at 11px / 1.6 leading; full file stays model-side.
 */
export const READ_BODY_PREVIEW_LINES = 8

/**
 * Cap streaming tool-group list so it cannot dominate the transcript.
 * ~12rem — keep in sync with TOOL_GROUP_LIST_MAX_PX for virtualizer estimates.
 */
export const TOOL_GROUP_LIST_VIEWPORT =
  'max-h-[min(12rem,28vh)] overflow-y-auto overscroll-contain'

/** Pixel ceiling matching TOOL_GROUP_LIST_VIEWPORT (12rem @ 16px). */
export const TOOL_GROUP_LIST_MAX_PX = 192

/**
 * Cap terminal tool output so streaming cannot inflate the transcript.
 * Keep in sync with TOOL_TERMINAL_VIEWPORT_MAX_PX for virtualizer estimates.
 */
export const TOOL_TERMINAL_VIEWPORT =
  'max-h-[min(12rem,28vh)] overflow-y-auto overscroll-contain'

/** Pixel ceiling matching TOOL_TERMINAL_VIEWPORT (12rem @ 16px). */
export const TOOL_TERMINAL_VIEWPORT_MAX_PX = 192

/** Standard inner padding for tool body content. */
export const TOOL_BODY_PAD = 'px-3 py-2'

/** Inner region inside a tool body. */
export const TOOL_BODY_INNER = 'px-3 py-1.5'

/** Flow with parent scroll — no nested max-height scrollport; pr-5 clears disclosure chrome. */
export const TOOL_BODY_FLOW = 'overflow-visible pr-5'

/** Family shells — compact todo / delete / read-only terminal (not bordered cards). */
export const TOOL_FAMILY_TERMINAL = 'overflow-hidden'
export const TOOL_FAMILY_TODO = 'rounded-md'
export const TOOL_FAMILY_DELETE = 'border-l-2 border-danger/50 pl-2'

/** Subtle surface shared by the in-flow docked composer. */
export const FLOATING_CHROME =
  'rounded-xl border border-border bg-bg motion-reduce:animate-none'

/** Theme token `--vy-shadow-chrome` — soft in light, deeper in dark. */
export const FLOATING_CHROME_SHADOW_BOTTOM =
  'shadow-[var(--vy-shadow-chrome)] animate-chrome-drop-in'

/** App chrome dimensions — sidebar header row aligns with title bar height. */
export const SIDEBAR_WIDTH_PX = 248
export const SIDEBAR_WIDTH_MIN_PX = 180
export const SIDEBAR_WIDTH_MAX_PX = 420
export const SIDEBAR_COLLAPSED_WIDTH_PX = 44
/** Wider collapsed rail on macOS so the toggle clears traffic lights. */
export const SIDEBAR_COLLAPSED_WIDTH_DARWIN_PX = 72
export const TITLE_BAR_HEIGHT = 'h-9'
export const TITLE_BAR_HEIGHT_PX = 36
/**
 * Width class names must be complete static strings so Tailwind can emit them.
 * Template-interpolated `w-[${n}px]` is invisible to the scanner and never ships.
 * Expanded desktop width is applied via inline style so it can be drag-resized.
 */
export const SIDEBAR_WIDTH = 'w-[min(248px,92vw)]'
export const SIDEBAR_WIDTH_COLLAPSED = 'w-[44px]'
export const SIDEBAR_WIDTH_COLLAPSED_DARWIN = 'w-[72px]'

/** Named container — children use `@sidebar/…` for width-aware density. */
export const SIDEBAR_CONTAINER = '@container/sidebar'

/** Sidebar shell — same surface as main column, no elevated chrome. */
export const SIDEBAR_SURFACE = 'bg-bg'

/** Quiet micro copy — dense panels, git chrome, dock toolbars. */
export const MICRO_LABEL =
  'text-caption font-medium tracking-[var(--vy-tracking-tight)] text-muted'

/** Uppercase section labels in composer dropdowns and tool bodies. */
export const MICRO_LABEL_CAPS =
  'text-2xs font-medium uppercase tracking-[var(--vy-tracking-caps)] text-secondary'

/** Sidebar section label — quiet category headers. */
export const SIDEBAR_SECTION_LABEL = `m-0 px-1 ${MICRO_LABEL}`

/** Horizontal padding for sidebar list body. */
export const SIDEBAR_PAD_X = 'px-2'

/**
 * Sidebar toolbar row — collapse + new chat; same {@link TITLE_BAR_HEIGHT} as main title bar.
 */
export const SIDEBAR_TOOLBAR_ROW = `app-region-drag flex items-center gap-0.5 px-2 ${TITLE_BAR_HEIGHT}`

/** Search field row below the sidebar toolbar. */
export const SIDEBAR_SEARCH_ROW = 'app-region-no-drag min-w-0 px-2 pb-2'

/** Workspace group inside the chat list — flat, no nested card chrome. */
export const SIDEBAR_WORKSPACE_GROUP = 'flex flex-col gap-0.5'

/** Indent for chat rows nested under a workspace header. */
export const SIDEBAR_INDENT = 'pl-1'

/**
 * Active-state rules (pick one per surface; do not mix within a list):
 * - {@link SIDEBAR_ROW_ACTIVE} — scrollable lists (chat rows): left accent bar, no fill.
 * - {@link SIDEBAR_NAV_ACTIVE} — sparse footer/toolbar nav: filled surface + inset ring.
 * - {@link SIDEBAR_WORKSPACE_ROW_ACTIVE} — group headers: text emphasis only.
 */

/** Filled ring active state — sidebar footer nav, dock tabs, marketplace tabs. */
export const SIDEBAR_NAV_ACTIVE =
  'bg-surface text-fg-strong ring-1 ring-inset ring-border/50'

/** Shared row chrome for chat rows — left accent on active. */
export const SIDEBAR_ROW =
  'rounded-lg px-2 py-1.5 text-sm leading-normal border-l-2 border-l-transparent'

/** Workspace header row inside a card — no left accent bar. */
export const SIDEBAR_WORKSPACE_ROW = 'rounded-lg px-1.5 py-1.5 text-sm leading-normal'

/** Active workspace header row — text emphasis only, no fill chrome. */
export const SIDEBAR_WORKSPACE_ROW_ACTIVE = 'text-fg-strong font-medium'

/** Active sidebar row — left accent bar, no fill chrome. */
export const SIDEBAR_ROW_ACTIVE = 'border-l-fg-strong text-fg-strong font-medium'

/** Hover surface for sidebar rows. */
export const SIDEBAR_ROW_HOVER = 'hover:bg-surface/30 hover:text-fg'

/** Hover surface for workspace headers. */
export const SIDEBAR_WORKSPACE_ROW_HOVER = 'hover:bg-surface/25 hover:text-fg'

export { RUN_LIST_CAP } from '@shared/domain/runs'

/** localStorage key for desktop sidebar collapse preference. */
export const SIDEBAR_COLLAPSED_KEY = 'vyotiq.sidebarCollapsed'

/** localStorage key for desktop sidebar width in px. */
export const SIDEBAR_WIDTH_KEY = 'vyotiq.sidebarWidth'

/** localStorage key for chat agent-browser panel open preference. */
export const BROWSER_PANEL_OPEN_KEY = 'vyotiq.browserPanelOpen'

/** localStorage key for which chat right panel is open. */
export const RIGHT_PANEL_KEY = 'vyotiq.rightPanel'

export const CHAT_RIGHT_PANEL_IDS = [
  'browser',
  'terminal',
  'changes',
  'plan',
  'pr'
] as const

export type ChatRightPanelId = (typeof CHAT_RIGHT_PANEL_IDS)[number]

export function isChatRightPanelId(value: string | null | undefined): value is ChatRightPanelId {
  return (
    value != null && (CHAT_RIGHT_PANEL_IDS as readonly string[]).includes(value)
  )
}

/** Immersive unified-tab id for the Agent (timeline + composer) view. */
export type DockImmersiveTabId = 'agent' | ChatRightPanelId

/** Shared content shell inside the right dock (parent owns CHAT_RIGHT_PANEL + tab bar). */
export const CHAT_RIGHT_PANEL_BODY =
  'flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden'

/**
 * Clamp dock width so a usable chat column remains beside the sidebar floor.
 * Reserves {@link SIDEBAR_WIDTH_MIN_PX} (not live sidebar width) so three-pane
 * layouts cannot push the agent column below {@link CHAT_COLUMN_MIN_USABLE_PX}.
 */
export function clampDockWidthPx(
  width: number,
  viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280
): number {
  const reservedChrome = CHAT_COLUMN_MIN_USABLE_PX + SIDEBAR_WIDTH_MIN_PX
  const maxByViewport = Math.max(
    DOCK_WIDTH_MIN_PX,
    Math.min(DOCK_WIDTH_MAX_PX, viewportWidth - reservedChrome)
  )
  return Math.min(maxByViewport, Math.max(DOCK_WIDTH_MIN_PX, Math.round(width)))
}

/** Clamp expanded sidebar width so a usable chat column remains. */
export function clampSidebarWidthPx(
  width: number,
  viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280
): number {
  const maxByViewport = Math.max(
    SIDEBAR_WIDTH_MIN_PX,
    Math.min(SIDEBAR_WIDTH_MAX_PX, viewportWidth - CHAT_COLUMN_MIN_USABLE_PX)
  )
  return Math.min(maxByViewport, Math.max(SIDEBAR_WIDTH_MIN_PX, Math.round(width)))
}
