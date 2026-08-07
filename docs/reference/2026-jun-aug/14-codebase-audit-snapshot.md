# Codebase audit snapshot

**Date:** 2026-08-07  
**Git commit:** `9f35b85` (main)  
**Working tree:** uncommitted changes present (see below)

## Verification gate (baseline)

Run before reference doc work:

| Command | Result | Details |
|---------|--------|---------|
| `pnpm typecheck` | **PASS** | `tsc` main + renderer, no errors |
| `pnpm test` | **PASS** | 263 files, 2338 passed, 5 skipped (~272s) |
| `pnpm lint` | **PASS** | `eslint .`, exit 0 |

## Verification gate (final — post-reference docs)

Re-run after `docs/reference/2026-jun-aug/` creation:

| Command | Result | Details |
|---------|--------|---------|
| `pnpm typecheck` | **PASS** | `tsc` main + renderer, no errors |
| `pnpm test` | **PASS** | 263 files, 2338 passed, 5 skipped (~141s) |
| `pnpm lint` | **PASS** | `eslint .`, exit 0 (7 warnings, 0 errors) |

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
| Vitest test files | 263 |
| Source layout | `src/main`, `src/preload`, `src/renderer`, `src/shared` |
| Built-in tools (README) | 45 |
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

Status at snapshot: **not executed** (automated gate only). Run manually per
`03-performance-diagnostics.md` and record pass/fail here when completed:

1. Terminal-heavy run in large workspace — _pending_
2. Verbose terminal output — _pending_
3. 160+ transcript rows during active run — _pending_
4. Changes panel with expanded diffs — _pending_
5. Agent browser panel visible — _pending_

## Browser vs external tooling

| Technology | In repo? | Role |
|------------|----------|------|
| Electron `WebContentsView` | Yes | Agent browser |
| CDP / Puppeteer | **No** | — |
| Playwright | Yes | GUI e2e shell smoke only |
| `cursor-ide-browser` MCP | **No** | — |

## Evidence

- `git status`, `git diff --stat`, `git rev-parse --short HEAD`
- `pnpm typecheck`, `pnpm test`, `pnpm lint` output (2026-08-07)
- Parallel codebase exploration agents + primary file reads
