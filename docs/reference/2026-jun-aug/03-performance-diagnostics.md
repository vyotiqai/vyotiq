# Performance and diagnostics

Source: `docs/agent-practices-2026.md` §8, perf modules in `src/main/perf/` and renderer.

**Principle:** measure before optimizing. Do not guess at bottlenecks.

## Main-process tooling (`VYOTIQ_PERF=1`)

Set in the shell before `pnpm dev` or `pnpm start`:

| Module | Role |
|--------|------|
| `src/main/perf/loadSnapshot.ts` | Event-loop lag + active runs every 5s (`eventLoopLagMs`, `dispatcher.pendingDepth`) |
| `src/main/perf/ipcTiming.ts` | `ipc:start` without matching `ipc:end` = Not Responding blocker |
| `src/main/agent/context/perfDebug.ts` | `assembleContext` / token estimate timings |
| `src/main/ipc/streamBatch.ts` | IPC batch stats (`ChatEventBatcher`) |

## Renderer opt-in

DevTools console:

```javascript
sessionStorage.setItem('vyotiq-perf', '1')
```

Logs via `src/renderer/src/lib/hooks/chatUiPerf.ts` (`[vyotiq-perf] chatUi` suspend/resume counters).

## Verified caps (in code today)

| Area | Cap | Source |
|------|-----|--------|
| Diff preview expanded | `MAX_EXPANDED_LINES = 200` | `DiffPreview.tsx` |
| Expand-all diffs | `EXPAND_ALL_MAX = 12` | `ChangesPanel.tsx`, `PrPanel.tsx` |
| Terminal UI buffer | `TERMINAL_UI_MAX = 64 KiB` | `createChatStreamController.ts` |
| Terminal output (main) | `TERMINAL_MAX_OUTPUT = 64 KiB` | `terminal.ts`, `terminalSessions.ts` |
| Events file rotation | `EVENTS_FILE_MAX_BYTES = 2 MiB` | `eventAppendQueue.ts` |
| Workspace watch walk | 5,000 files, 1 MiB blob/file | `workspaceMutationWatch.ts` (`SNAPSHOT_FILE_CAP`, `SNAPSHOT_BLOB_MAX_BYTES`) |
| Transcript virtualizer | `VIRTUALIZE_MIN_ROWS = 160` | `MessageList.tsx` |
| Shiki highlight | lazy langs, `HIGHLIGHT_MAX_LINES = 64` | `useDiffHighlight.ts` |
| Search scan | `SEARCH_SCAN_CAP = 5000` | `search.ts` |
| Web fetch | `WEB_FETCH_MAX_BYTES = 2 MiB` | `webFetch.ts` |
| Browser snapshot chars | `DEFAULT_SNAPSHOT_CHARS = 40_000` | `agentBrowser.ts` |
| Browser tabs | `MAX_BROWSER_TABS = 16` | `agentBrowser.ts` |
| Write guard | `LARGE_WRITE_MAX_CHARS = 50_000`, `LARGE_WRITE_MAX_LINES = 500` | `writeGuard.ts` |

## Known inline freeze comments (verified)

- `DiffPreview.tsx` — full diff + syntax highlight cost when expanded
- `ipcTiming.ts` — Not Responding diagnosis via unmatched IPC spans
- `transcriptRows.ts` — streaming fingerprint / row rebuild on each items revision

## Event append correctness

Prefer `loadEventsAsync` / `flushEventAppends` over sync `loadEvents` on hot paths.
Sync `loadEvents` reads `events.jsonl` without blocking the main thread; callers
that need a complete tail must await the append chain first.

## Manual repro matrix (perf audit)

Document pass/fail when running manually:

1. Agent run with many terminal commands in a large workspace
2. Agent run with verbose terminal output (build/test logs)
3. Long chat transcript (160+ rows) while agent is running
4. Changes panel open with multiple expanded diffs
5. Agent browser panel visible

Capture: main `[vyotiq-perf] load` (`eventLoopLagMs`), unmatched `ipc:start`,
renderer `[vyotiq-perf] chatUi` counters.

## Evidence

- `src/main/perf/loadSnapshot.ts`, `src/main/perf/ipcTiming.ts`
- `src/main/ipc/streamBatch.ts`
- `src/renderer/src/lib/hooks/chatUiPerf.ts`
- `src/renderer/src/features/chat/components/MessageList.tsx`
- `src/renderer/src/features/chat/components/DiffPreview.tsx`
- `src/renderer/src/features/chat/components/ChangesPanel.tsx`
- `src/renderer/src/lib/hooks/createChatStreamController.ts`
- `tests/renderer/chat/messageList.test.tsx`
- `tests/renderer/chat/chatPerfIsolation.test.tsx`
