# Codebase audit snapshot

**Date:** 2026-08-08  
**Git commit:** `8132623` (main)  
**Working tree:** uncommitted E2E gap follow-up changes present (P0–P3 remediations)

## Verification gate (baseline)

Run before reference doc work:

| Command | Result | Details |
|---------|--------|---------|
| `pnpm typecheck` | **PASS** | `tsc` main + renderer, no errors |
| `pnpm test` | **PASS** | 263 files, 2338 passed, 5 skipped (~272s) |
| `pnpm lint` | **PASS** | `eslint .`, exit 0 |

## Verification gate (gap audit remediation — 2026-08-08)

| Command | Result | Details |
|---------|--------|---------|
| `pnpm typecheck` | **PASS** | main + renderer |
| `pnpm test` | **PASS** | 275 files, 2415 passed, 5 skipped |
| `pnpm lint` | **PASS** | 8 warnings, 0 errors |
| `pnpm build` | **PASS** | electron-vite production build |
| `pnpm test:gui-e2e` | **PASS** | chat-send, tool-approval-onboarding, offline-queue fixture replay |

CI: `.github/workflows/ci.yml` — matrix `ubuntu-latest` + `windows-latest`.

## Verification gate (E2E gap follow-up — 2026-08-08)

Full sequential gate after P0–P3 remediations (fixture replay: `VYOTIQ_E2E_FIXTURE=1`):

| Command | Result | Details |
|---------|--------|---------|
| `pnpm typecheck` | **PASS** | main + renderer, no errors |
| `pnpm test` | **PASS** | 278 files, 2432 passed, 5 skipped (~284s) |
| `pnpm lint` | **PASS** | 8 warnings, 0 errors |
| `pnpm build` | **PASS** | electron-vite production build |
| `pnpm test:gui-e2e` | **PASS** | 10 passed (~34s): smoke, chat-send, chatPane.drag, offline-queue, tool-approval-onboarding |

**Follow-up remediations landed**

| Priority | Scope | Status |
|----------|-------|--------|
| **P0** | Multi-pane onboarding gate; offline enqueue vs onboarding order; single `useOfflineSendQueue` owner; `ask_question` reject without ids | **done** |
| **P1** | `listRuns` cache / stale reconcile throttle; `interruptOrphanRuns` logger; `secretsLoadError` on IPC fail | **done** |
| **P2** | `browser_search` toolUi/meta/summary; remove orphan `webSearch.ts`; ollamaBaseUrl strip + offline clear UI tests | **done** |
| **P3** | surfaceKey align, multi-pane handlers, live turn chrome dedup, approval error local, shared hooks | **done** |

Gate fix during follow-up verify: `messageList.test.tsx` live-turn flow assertion updated for P3 redundant chrome (TurnSummary owns phase; activity/card hidden).

## Stack (from `package.json`)

| Layer | Version |
|-------|---------|
| Electron | 43.2.0 |
| React | 19 |
| TypeScript | 7 |
| Vite / electron-vite | 7 / 5 |
| Tailwind CSS | 4 |
| Vitest | 3.2 |
| Playwright | 1.62 |
| Zod | 3.25 |
| MCP SDK | 1.29 |

Package manager: pnpm 11.20.0.

## Repository metrics

| Metric | Value |
|--------|-------|
| Vitest test files | 278 |
| Source layout | `src/main`, `src/preload`, `src/renderer`, `src/shared` |
| Built-in tools (README) | 44 |
| IPC channel keys | ~120+ (`channels.ts`) |
| Marketplace skills | 18 SKILL.md |
| Marketplace rules | 4 |

## Feature areas verified

| Area | Implementation | Test coverage |
|------|----------------|---------------|
| Agent loop | `src/main/agent/loop.ts` | `agentLoopFollowUp.test.ts`, e2e pipeline |
| Checkpoints / rewind | `checkpoints.ts`, `rewindRun.ts` | `checkpoints.test.ts`, `rewindRun.test.ts` |
| Follow-up queue | `runRegistry.ts` | `runRegistry.test.ts` |
| Browser tools | `agentBrowser.ts` | `agentBrowserRefs.test.ts`, tool routing tests |
| Terminal / PTY | `terminal.ts`, `ptySessions.ts` | `ptyLifecycle.test.ts`, `terminalFormat.test.ts` |
| IPC contract | `register.ts`, `channels.ts` | `ipcContract.test.ts`, `ipcRegister.test.ts` |
| Harness | `harness.ts`, `default.md` | `harness*.test.ts`, `toolsSchema.test.ts` |
| Token invariants | `contextBudget.ts` | `tokenCostRegression.invariants.test.ts` |
| Renderer chat UI | `ChatView`, `Composer`, `MessageList` | extensive `tests/renderer/chat/` |

## Working-tree delta (uncommitted at snapshot)

**62 modified files**, +2098 / −623 lines. Not yet committed to `9f35b85`.

### In-flight themes

| Theme | Key files |
|-------|-----------|
| Follow-up queue | `runRegistry.ts`, `register.ts`, `channels.ts` (`chat:followUp*`) |
| Rewind / Revert back | `rewindRun.ts`, `UserPrompt.tsx` |
| Composer refactor | `Composer.tsx` (largest UI diff) |
| Chat stream controller | `createChatStreamController.ts` (+terminal UI buffer) |
| Sidebar chrome | `SidebarTopBar.tsx`, `SidebarSearchChrome.tsx` |
| Network monitor | `networkMonitor.ts`, `useNetworkStatus.ts` |
| Terminal formatting | `terminalFormat.ts`, `TerminalBody.tsx` |

Untracked: `docs/reference/2026-jun-aug/` (16 files), `docs/architecture.md`,
`docs/research/token-cost-jun-aug-2026.md`, `.cursor/mcp.json`,
`.devin/config.local.json`, `tests/renderer/sidebar/sidebarTopBar.test.tsx`.

**Note:** Reference docs describe committed behavior plus working-tree features
where evidence exists in modified files and tests.

## Confirmed gaps

| Referenced | Status | Substitute |
|------------|--------|------------|
| `docs/research/token-cost-jun-aug-2026` | **Stub** — points to `04-token-cost-invariants.md` + freeze tests |
| `docs/architecture.md` | **Stub** — points to `15-architecture.md` |
| CCE MCP live connection | Error at snapshot | `AGENTS.md` documents CCE; `.cursor/mcp.json` lists context-engine |

## Manual repro matrix (perf audit)

Status at snapshot: **automated caps + row-build regression green** (2026-08-08 follow-up gate); manual UI spot-check still recommended on dev build for scenarios 1 and 5.

| # | Scenario | Automated | Manual |
|---|----------|-----------|--------|
| 1 | Terminal-heavy run in large workspace | — | pending (automated caps green elsewhere; manual spot-check still recommended) |
| 2 | Verbose terminal output | `TERMINAL_UI_MAX` (64 KiB) asserted in `perfMatrixCaps.test.ts` | automated caps green; manual spot-check still recommended |
| 3 | 160+ transcript rows during active run | `perfMatrixCaps.test.ts` builds ≥160 rows <2s; `VIRTUALIZE_MIN_ROWS=160` | automated caps green; manual spot-check still recommended |
| 4 | Changes panel with expanded diffs | `MAX_EXPANDED_LINES` / `EXPAND_ALL_MAX` caps in `perfMatrixCaps.test.ts` | automated caps green; manual spot-check still recommended |
| 5 | Agent browser panel visible | `agentBrowserPanel.test.tsx` loadError coverage | automated caps green; manual spot-check still recommended |

**P0–P3 (E2E gap follow-up):** multi-pane + offline onboarding wiring; listRuns/logging/secrets; `browser_search` UI + dead-code cleanup; live turn chrome / shared hooks polish. Covered by renderer unit tests + GUI e2e (onboarding, offline flush, pane drag).

**Earlier post gap-audit notes:** `security.test.ts` (CSP + attachSecurity), `agentBrowserUrl.test.ts` (unrestricted URLs), extended `toolApproval.test.tsx` (deny error recovery); `offlineQueueStore.test.ts`, `useOfflineSendQueue.test.tsx`, `toolApprovalOnboarding.test.tsx`.

**Platform:** Windows GPU sandbox re-enabled (removed `disable-gpu*` workarounds in `src/main/index.ts`).

## Browser vs external tooling

| Technology | In repo? | Role |
|------------|----------|------|
| Electron `WebContentsView` | Yes | Agent browser |
| CDP / Puppeteer | **No** | — |
| Playwright | Yes | GUI e2e shell smoke only |
| `cursor-ide-browser` MCP | **No** | — |

## Evidence

- `git status`, `git diff --stat`, `git rev-parse --short HEAD`
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm build`, `pnpm test:gui-e2e` output (2026-08-08 follow-up)
- Parallel codebase exploration agents + primary file reads
