# Chat pane layout (multi-pane)

Window-level side-by-side chat sessions. Flat horizontal rows only; no nested splits.

## Data model

`ChatPaneLayout` in `src/renderer/src/lib/chat/chatPaneLayout.ts`:

| Field | Role |
|-------|------|
| `panes` | `{ paneId, workspacePath, runId }` — cross-workspace allowed |
| `focusedPaneId` | Which pane owns composer input, dock, and sidebar focus highlight |
| `sizes` | Relative flex weights; length matches `panes` |

Persistence: localStorage key `vyotiq.chatPaneLayout` via `serializePaneLayout` / `deserializePaneLayout`.

## Capacity

Minimum usable chat column: `CHAT_COLUMN_MIN_USABLE_PX = 360` (`layout.ts`).

```
maxPanes = floor((viewportWidth − reservedChrome) / 360)
```

`reservedChrome` = sidebar width + side rail (`CHAT_SIDE_RAIL_WIDTH_PX`) + open dock width.

Helpers:

- `maxPaneCount(viewportWidth, reservedPx)` — `chatPaneLayout.ts`
- `paneCapacityReservedPx({ sidebarWidthPx, dockWidthPx, dockOpen })` — `layout.ts`
- `readSidebarWidthPxForCapacity()` — reads collapsed/expanded sidebar from localStorage

At `maxPanes === 1`, drag-split is refused (`insertPaneBeside` returns `null`).

## Drop zones

Drag source: sidebar `ChatRow` with MIME `application/x-vyotiq-session`.

`resolvePaneDropZone(x, width)` maps pointer X inside a pane:

| Zone | X range | Effect |
|------|---------|--------|
| `left` | &lt; ⅓ width | Split left of anchor |
| `center` | ⅓ – ⅔ | Replace anchor session; focus if already open |
| `right` | &gt; ⅔ | Split right of anchor |

`ChatPaneHost` renders drop targets even in single-pane mode so the first split works.

## Resize

Pane pair resize enforces `CHAT_COLUMN_MIN_USABLE_PX` per column via flex weights.
`PanelResizeHandle` min/max derived from row width and `ResizeObserver`.

Dock width: `clampDockWidthPx(width, viewport, { paneCount, sidebarWidthPx })` reserves
`paneCount × 360 + sidebar + side rail`.

## Focus and input routing

- Click or composer/message-list focus → `focusPaneById`
- Shared right dock owned by focused pane's workspace/run
- Send/stop/scroll/draft routed per pane controller and run id
- `composerDraftByRunId` and `scrollTopByRunId` key per-session state within a workspace

## UI chrome

Multi-pane only (`panes.length > 1`):

- Always-visible header with session title + Close (`New chat` for drafts)
- Focused pane: inset ring; rightmost header/composer clear shared `ChatSideRail` when rail is mounted
- Content `pt-7` clears header; empty drafts use docked composer (no centered hero)
- Panes use `flex-shrink: 0` + `minWidth: 360`; host scrolls horizontally when the row is tight
- No tab bar, badges, or split chrome strip

Single-pane: identical to pre-split layout (no header).

Sidebar: open-in-pane (`SIDEBAR_ROW_OPEN`) vs focused (`SIDEBAR_ROW_FOCUSED`).

## Sanitization

`sanitizePaneLayout(layout, openWorkspacePaths, maxPanes)`:

- Removes panes whose workspace is closed
- Clamps to `maxPanes`; preserves focused pane when dropping excess panes
- `removeSessionFromLayout` on run delete/close

## Acceptance criteria (tests)

| Behavior | Test |
|----------|------|
| Drop zone thirds | `chatPaneLayout.test.ts` — `resolvePaneDropZone` |
| Center drop focuses existing | `chatPaneLayout.test.ts` — `applyPaneDrop` |
| Sanitize closed workspace | `chatPaneLayout.test.ts`, `useWorkspaceManager.test.tsx` |
| Click open session no dup | `useWorkspaceManager.test.tsx` |
| Drop UI | `chatPaneHost.drop.test.tsx` |
| Drag source payload | `chatRow.drag.test.tsx` |
| Dock/sidebar clamp | `layoutClamp.test.ts` |
| E2E split/focus/close | `tests/gui-e2e/chatPane.drag.spec.ts` (video on) |

## Evidence

- `src/renderer/src/lib/chat/chatPaneLayout.ts`
- `src/renderer/src/features/chat/ChatPaneHost.tsx`
- `src/renderer/src/features/chat/ChatView.tsx`
- `src/renderer/src/lib/hooks/useWorkspaceManager.ts`
- `src/renderer/src/lib/utils/layout.ts`
- `src/renderer/src/app/App.tsx`
- `tests/renderer/chat/chatPaneLayout.test.ts`
- `tests/renderer/chat/chatPaneHost.drop.test.tsx`
- `tests/renderer/chat/useWorkspaceManager.test.tsx`
- `tests/renderer/lib/layoutClamp.test.ts`
- `tests/gui-e2e/chatPane.drag.spec.ts`
