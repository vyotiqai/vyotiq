# Browser tools

Agent browsing uses Electron **`WebContentsView`** — not CDP, Puppeteer, or
Playwright. Playwright exists only for Electron shell gui-e2e tests.

## Implementation (`agentBrowser.ts`)

| Constant | Value |
|----------|-------|
| Partition | `persist:vyotiq-agent-browser` |
| `MAX_BROWSER_TABS` | 16 |
| `DEFAULT_SNAPSHOT_CHARS` | 40,000 |
| `MAX_INTERACTIVE_REFS` | 80 |
| Nav timeout default / max | 30s / 60s |
| Wait timeout default / max | 15s / 60s |

Mechanisms:

- Navigation, click, type, scroll, fill via `wc.executeJavaScript()`
- Screenshots via `wc.capturePage()` → JPEG artifact `browser/snapshot.jpg`
- Snapshot refs: `@eN` format (`agentBrowserRefs.ts`)
- SSRF: `assertPublicUrl`, `isSyncBlockedUrl` from `webFetch.ts`
- Serialized per workspace (`browserOpChains` map)

## Built-in tools (13)

From `src/main/agent/schemas/tools.ts`:

`browser_navigate` · `browser_snapshot` · `browser_click` · `browser_type` ·
`browser_scroll` · `browser_fill` · `browser_tabs` · `browser_back` ·
`browser_forward` · `browser_wait_for_selector` · `browser_wait_for_url` ·
`browser_press_key` · `browser_select_option`

Handlers route through `src/main/agent/tools/index.ts` → `agentBrowser.ts`.

## Classification and mode policy

`classify.ts`: `browser_*` are **serial-only**, always approval-gated (embedded `WebContentsView`).

`modePolicy.ts` Ask-mode allowlist (browse-only):

- Allowed: `browser_navigate`, `browser_snapshot`, `browser_scroll`, `browser_tabs`,
  `browser_back`, `browser_forward`, `browser_wait_for_selector`, `browser_wait_for_url`
- Denied in Ask: `browser_click`, `browser_type`, `browser_fill`, `browser_press_key`,
  `browser_select_option` (mutating live sites)

## Renderer UI

| Component | Role |
|-----------|------|
| `AgentBrowserPanel.tsx` | Docked panel; URL bar, tabs, bounds sync via `browserSetBounds`; passes `workspacePath` on navigate |
| `browserRecents.ts` | localStorage visit history (`vyotiq.browserRecents`) |
| `ChatView.tsx` | Mounts panel as dock tab `browser` |
| `BrowserBody.tsx` | Snapshot refs, tabs, action results in chat stream |
| `toolUi/registry.ts` | Maps all 13 tools to browser bodies; globe icon |
| `mentionModel.ts` | `@browser` mention injects browser-tools hint |

**Not a web browser:** `ChangedFilesBrowser.tsx` — git changed-files list.

## IPC channels

From `src/shared/ipc/channels.ts`:

`browser:state`, `browser:getState`, `browser:focus`, `browser:close`,
`browser:selectTab`, `browser:back`, `browser:forward`, `browser:setBounds`,
`browser:navigate`, `browser:reload` (re-`loadURL` of current URL), `browser:takeScreenshot`, `browser:clearBrowsingData`

`browser:navigate` accepts optional `workspacePath` so panel navigation tags tabs per workspace.

Snapshot refs use named fields: `role=`, `name=`, `css=` (multi-word roles supported).

Schemas: `src/shared/ipc/schemas/browser.ts`

## Related static web tools

- `web_fetch` — HTTP(S) static fetch with SSRF checks
- `web_search` — DuckDuckGo HTML search

## Evidence

- `src/main/app/agentBrowser.ts`, `agentBrowserRefs.ts`
- `src/main/agent/schemas/tools.ts`, `tools/index.ts`, `classify.ts`, `modePolicy.ts`
- `src/renderer/src/features/chat/components/AgentBrowserPanel.tsx`
- `src/renderer/src/features/chat/toolUi/bodies/BrowserBody.tsx`
- `src/preload/index.ts`, `src/shared/vyotiqApi.ts`
- `tests/main/unit/agentBrowserRefs.test.ts`
- `tests/main/unit/executeToolGitDiagBrowser.test.ts`
- `tests/main/unit/modePolicy.test.ts`
- `tests/renderer/chat/agentBrowserPanel.test.tsx`, `chatView.placement.test.tsx`
- `tests/renderer/chat/toolUi/registry.test.ts`, `parsers.test.ts`
