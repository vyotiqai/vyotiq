# Agent practices (June–August 2026)

Durable reference synthesized from verified sources only: harness, handbook,
`AGENTS.md`, mode policy, checkpoint/rewind tests, and session decisions from
August 2026 audits. Not speculative guidance.

**Full reference library:** [docs/reference/2026-jun-aug/README.md](./reference/2026-jun-aug/README.md)
(checkpoints, security, browser, IPC, UI, test harness, audit snapshot).

## 1. Checkpoint semantics

Workspace file mutations made through checkpointed tools are snapshotted
**before** the mutation (`recordPrior`), then finalized per invoke into
`checkpoints/{id}/meta.json` plus prior-content blobs under
`checkpoints/{id}/files/`.

| Rule | Behavior |
|------|----------|
| First prior wins | Same path recorded once per invoke; later tools on that path reuse the original blob |
| Per-invoke session | `beginWriteCheckpoint` → tool `recordPrior` calls → `finalizeWriteCheckpoint` |
| Anchor index | `anchorUserMessageIndex` is the user message the invoke answered (already in `messages.jsonl`) |
| Auto-keep prior turns | On finalize, older unresolved checkpoints are marked kept so only the latest turn owns Keep/Discard UI |
| Soft no-op | `resolveWrites` with no open checkpoint returns empty success (UI may call after banner cleared) |

Evidence: `src/main/agent/checkpoints.ts`, `tests/main/unit/checkpoints.test.ts`.

## 2. Revert surfaces

| Surface | Effect | Starts agent? |
|---------|--------|---------------|
| Keep / Discard (per path or all) | Resolve latest (or named) checkpoint; discard restores blobs | No |
| Undo all | `undoWrites` — restore unresolved paths on latest undoable checkpoint | No |
| Edit message + resend | `prepareRewindAndReplaceUserMessage` + `rewindWritesFrom` + new invoke | Yes |
| Revert back (per user bubble) | `prepareRewindToUserMessage` + `chat:rewind` IPC; keep user text; truncate later turns | No |

IPC guards: run must be inactive (or cancelled first) for undo/resolve/rewind.
Evidence: `src/main/ipc/register.ts`, `src/main/agent/rewindRun.ts`,
`src/renderer/src/features/chat/components/ChangeSummary.tsx`.

## 3. Tool coverage matrix

| Tool / path | Checkpointed? | Notes |
|-------------|---------------|-------|
| `edit`, `str_replace`, `multi_edit`, `delete` | Yes | `recordPrior` in tool handlers |
| `generate_image` / `edit_image` (Agent mode) | Yes | Dry-run in Ask/Plan — no write |
| Terminal known-path + watcher | Yes (phased) | Parser + post-exec workspace diff |
| MCP filesystem write tools | Yes (phased) | Known path args + watcher fallback |
| Recursive directory delete | No (`undoable: false`) | Directory entry only; per-file tree snap not implemented (v1) |
| `plan.md`, `contract.md`, `todos.json` | No (intentional) | Run artifacts |
| `.vyotiq/memory/*` (`memory_write`) | No (intentional) | Durable memory |
| `git_commit` / VCS state | No (intentional) | Out of scope |
| Sub-agents | N/A | Feature removed; sibling tools share parent invoke session |

Harness statement: “Workspace writes are checkpointed for Keep/Discard;
`plan.md` and `contract.md` run artifacts are not Keep/Discard checkpointed.”
(`resources/harness/default.md`)

## 4. Persistence layout

Per run under `{userData}/workspaces/{workspaceId}/sessions/{runId}/`:

| Path | Role |
|------|------|
| `messages.jsonl` | Canonical transcript |
| `events.jsonl` | Ops log including `writes_checkpoint` |
| `checkpoints/index.json` | Checkpoint id list |
| `checkpoints/{id}/meta.json` | File entries + undo/resolve flags |
| `checkpoints/{id}/files/…` | Prior content blobs |
| `status.json` | Run status |
| `receipt.json` / `trajectory.jsonl` | Summaries — regenerated on rewind |
| `plan.md` / `contract.md` | Not Keep/Discard checkpointed |

Handbook: `docs/harness-handbook.md`.

## 5. Known limitations and intentional exclusions

- Opaque shell/MCP mutations without parseable paths rely on the workspace
  mutation watcher (post Phase 2).
- Memory and run artifacts stay out of Keep/Discard by product choice.
- Partial blob restore failure leaves the checkpoint unresolved (`undoWrites`)
  so a retry can finish remaining paths.
- Legacy checkpoints without `anchorUserMessageIndex` are included when
  rewinding so later-turn writes are never left unrestored.

## 6. Operational practices (audit-verified)

| Practice | Decision / evidence |
|----------|---------------------|
| Mid-session stale running reconciliation | `reconcileStaleRuns` (2 min age) on `listRuns`; boot `interruptOrphanRuns` with `maxAgeMs: 0` |
| Compaction retained decisions | Persist on `CompactionRecord`; reinject via `loopHint` until present in kept messages |
| LOOP_SAFETY streak | Resets on new invoke; do not carry `consecutiveToolFailureSteps` across invokeIds |
| Status / receipt flush | Status step patches flush immediately; receipt cadence decoupled from per-step artifacts |
| MCP pin / admit | Agent mode only; allowlist/denylist; `request_mcp_tools` / `release_mcp_tools` for schema budget |
| Atomic writes | Prefer rename-based persistence for meta/index (`atomicWriteJson`) |
| CCE search | Prefer `context_search` over whole-file reads when exploring; `session_recall` before non-trivial answers |
| Dev launch | Unset `ELECTRON_RUN_AS_NODE` in IDE shells; kill orphan `electron.exe` before relaunch |

Sources: session decisions (stale-run, retained decisions, loop safety, status flush),
`AGENTS.md`, harness + handbook.

## 7. Verification gate

After checkpoint or rewind changes:

```bash
pnpm typecheck
pnpm test
pnpm lint
```

Manual smoke: edit → Discard; terminal write → Discard; MCP filesystem write →
Discard; edit-and-resend rewind; bubble Revert back; reload Keep/Discard card
from `events.jsonl`.

## 8. Performance & diagnostics

Measure before optimizing. Do not guess at bottlenecks.

### Main-process tooling (`VYOTIQ_PERF=1`)

Set in the shell before launch (`pnpm dev` / `pnpm start`):

| Module | Role |
|--------|------|
| `src/main/perf/loadSnapshot.ts` | Event-loop lag + active runs every 5s (`eventLoopLagMs`, `dispatcher.pendingDepth`) |
| `src/main/perf/ipcTiming.ts` | `ipc:start` without matching `ipc:end` = Not Responding blocker |
| `src/main/agent/context/perfDebug.ts` | `assembleContext` / token estimate timings |
| `src/main/ipc/streamBatch.ts` | IPC batch stats |

Launch note: unset `ELECTRON_RUN_AS_NODE` in IDE shells; kill orphan `electron.exe`
before relaunch (see §6).

### Renderer opt-in

DevTools: `sessionStorage.setItem('vyotiq-perf','1')` →
`src/renderer/src/lib/hooks/chatUiPerf.ts` (`[vyotiq-perf] chatUi` suspend/resume
counters).

### Verified caps (in code today)

| Area | Cap | Source |
|------|-----|--------|
| Diff preview | `MAX_EXPANDED_LINES=200` | ChangesPanel / DiffPreview |
| Expand-all diffs | `EXPAND_ALL_MAX=12` | ChangesPanel |
| Terminal UI buffer | `TERMINAL_UI_MAX=64KiB` | createChatStreamController |
| Terminal output (main) | `TERMINAL_MAX_OUTPUT` | terminalSessions |
| Events file rotation | `EVENTS_FILE_MAX_BYTES=2MiB` | eventAppendQueue |
| Workspace watch walk | 5,000 files, 1MiB SHA1/file | workspaceMutationWatch |
| Transcript virtualizer | `VIRTUALIZE_MIN_ROWS=160` | MessageList |
| Shiki highlight | lazy langs, `HIGHLIGHT_MAX_LINES=64` | markdown pipeline |

### Token-cost invariants (test-only)

Stub `docs/research/token-cost-jun-aug-2026.md` — canonical substitute:
`tests/shared/tokenCostRegression.invariants.test.ts` (64k compaction soft cap,
MCP pin TTL=16 steps, soft max=12 tools).

### Known inline freeze comments (verified)

- `DiffPreview.tsx` — full diff + syntax highlight cost when expanded
- `ipcTiming.ts` — Not Responding diagnosis via unmatched IPC spans
- `transcriptRows.ts` — streaming fingerprint / row rebuild on each items revision

### Event append correctness

Prefer `loadEventsAsync` / `flushEventAppends` over sync `loadEvents` on hot paths.
Sync `loadEvents` reads `events.jsonl` without blocking the main thread; callers
that need a complete tail must await the append chain first.

### Manual repro matrix (perf audit)

1. Agent run with many terminal commands in a large workspace
2. Agent run with verbose terminal output (build/test logs)
3. Long chat transcript (160+ rows) while agent is running
4. Changes panel open with multiple expanded diffs
5. Agent browser panel visible

Capture: main `[vyotiq-perf] load` (`eventLoopLagMs`), unmatched `ipc:start`,
renderer `[vyotiq-perf] chatUi` counters.

### Verification gate

Same as §7: `pnpm typecheck && pnpm test && pnpm lint`.
