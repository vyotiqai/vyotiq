# UI and UX patterns

Renderer React UI: sidebar, chat stream, composer, dock panels.

## App shell

- Frameless window; custom title bar (`TitleBar.tsx`)
- Sidebar: workspace list, chat list, search chrome (`SidebarTopBar`, `SidebarSearchChrome`)
- `AppShell.tsx` — layout grid; light/dark theme (WCAG AA neutral grayscale)

## Design tokens

Typography and spacing live in `src/renderer/src/styles.css` (`@theme`) and `src/renderer/src/lib/utils/layout.ts` (Tailwind class strings).

### Type scale (`styles.css`)

| Token | Size | Tailwind class |
|-------|------|----------------|
| `--text-3xs` | 9px | `text-3xs` |
| `--text-2xs` | 10px | `text-2xs` |
| `--text-caption` | 11px | `text-caption` |
| `--text-xs` | 12px | `text-xs` |
| `--text-sm` | 13px | `text-sm` (body default) |
| `--text-md` | 14px | `text-md` (composer input) |
| `--text-lg` | 15px | `text-lg` |
| `--text-heading` | 16px | `text-heading` (page titles) |
| `--text-title` | 17px | `text-title` |

Fonts: Plus Jakarta Sans (sans), JetBrains Mono (mono) via `@fontsource/*`.

Letter-spacing: `--vy-tracking`, `--vy-tracking-tight`, `--vy-tracking-body`, `--vy-tracking-caps`.

### Layout tokens (`layout.ts`)

| Token | Role |
|-------|------|
| `CHAT_GUTTER` / `SETTINGS_GUTTER` | Horizontal inset `px-4 sm:px-5` |
| `CHAT_COLUMN` / `CHAT_COLUMN_MAX` | Centered chat column, max 840px |
| `CHAT_STAGE_INSET` | Left gutter + `pr-10` for floating side rail |
| `SETTINGS_COLUMN` / `SETTINGS_COLUMN_MAX` | Settings column, max 520px |
| `MARKETPLACE_COLUMN` | Marketplace column, max 1040px |
| `TRANSCRIPT_ROW_GAP` | `pb-2.5` between transcript rows |
| `TRANSCRIPT_WORK_ROW_GAP` | `pb-4` around tool/reasoning rows |
| `TRANSCRIPT_TURN_GAP` | `pt-8` before a new user turn |
| `USER_PROMPT_SURFACE` | User bubble chrome + typography |
| `MICRO_LABEL` / `MICRO_LABEL_CAPS` | Dense panel labels |
| `SIDEBAR_ROW_ACTIVE` | Chat list active: left accent bar |
| `SIDEBAR_NAV_ACTIVE` | Footer nav / tabs active: filled ring |

### Active-state rules

- **Chat rows** (`SIDEBAR_ROW_ACTIVE`): left accent bar, no fill.
- **Footer nav, dock tabs, marketplace tabs** (`SIDEBAR_NAV_ACTIVE`): filled surface + inset ring.
- **Workspace headers** (`SIDEBAR_WORKSPACE_ROW_ACTIVE`): text emphasis only.

## Chat view

`ChatView.tsx` — central surface:

- `MessageList.tsx` — transcript; virtualizes at `VIRTUALIZE_MIN_ROWS = 160`
- `UserPrompt.tsx` — user bubbles; Revert back control
- `ToolGroup.tsx` — grouped tool rows
- `ChatStreamLeaves.tsx` — streaming assistant leaves
- `ChangeSummary.tsx` — Keep/Discard checkpoint banner

`CHAT_STAGE_INSET` keeps transcript/composer clear of the floating `ChatSideRail` icon strip (`CHAT_SIDE_RAIL_WIDTH` = `w-10`).

Multi-pane side-by-side sessions: see [16-chat-pane-layout.md](./16-chat-pane-layout.md).

## Composer

`Composer.tsx` — largest UI surface:

- Model picker, thinking controls, compaction
- `@mention` system: files, browser, skills (`mentionModel.ts`, `resolveMentions.ts`)
- `ContextMeter.tsx` — live context window meter
- `ComposerToolbar.tsx` — mode, attachments, send/stop

## Dock panels (right rail)

`dockPanels.ts` — single source of truth:

| Panel id | Label |
|----------|-------|
| `browser` | Browser |
| `terminal` | Terminal |
| `changes` | Changes |
| `pr` | Pull Request |
| `plan` | Plan |

`ChatSideRail.tsx` + `DockTabBar.tsx` — open/close panels.
`AgentBrowserPanel` kept mounted when hidden; bounds cleared on hide (tested).

### Immersive dock

- `DOCK_EXPANDED_KEY` / `IMMERSIVE_TAB_KEY` — localStorage for unified Agent + panel tabs
- `data-dock-immersive` on shell when immersive mode is active
- `DockTabBar` variant `immersive` — pill tabs in title bar region

## Git chrome

`GitChrome.tsx` — branch strip, change pills in chat header.
`ChangesPanel.tsx` — diff preview, expand-all cap 12 files.
`PrPanel.tsx` — GitHub PR via `gh` CLI.

## Tool UI registry

`src/renderer/src/features/chat/toolUi/`:

- `registry.ts` — maps each built-in tool to body component + icon
- `bodies/` — `BrowserBody`, `TerminalBody`, `WebFetchBody`, etc.
- `parsers/` — structured output parsing per tool family
- `chrome.tsx` — shared tool row chrome

## Performance-related UX

- `@tanstack/react-virtual` for long lists
- Shiki highlighting capped at 64 lines (`useDiffHighlight.ts`)
- Diff expanded cap 200 lines (`DiffPreview.tsx`)
- Chat UI perf hooks: `chatUiPerf.ts` (opt-in via sessionStorage)

## Settings and marketplace

- `SettingsNav.tsx`, section components (General, Providers, Agent, Marketplace Registry)
- `MarketplaceView.tsx` — Browse / Manage catalog
- Shared `PageHeader` (`lib/ui/PageHeader.tsx`) for section titles

## Evidence

- `src/renderer/src/app/`, `src/renderer/src/features/chat/`
- `src/renderer/src/lib/utils/dockPanels.ts`, `layout.ts`
- `src/renderer/src/lib/hooks/createChatStreamController.ts`, `useChatStream.ts`
- `src/renderer/src/styles.css`
- `tests/renderer/composer/composer.test.tsx`, `composer.layout.test.tsx`
- `tests/renderer/sidebar/sidebarChrome.test.tsx`, `sidebarTopBar.test.tsx`
- `tests/renderer/chat/messageList.test.tsx`, `chatView.placement.test.tsx`
- `tests/renderer/lib/layoutTokens.test.ts`
