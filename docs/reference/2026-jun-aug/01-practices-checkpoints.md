# Checkpoint semantics and revert surfaces

Source: `docs/agent-practices-2026.md` §1–5, verified against implementation.

## Checkpoint semantics

Workspace file mutations through checkpointed tools are snapshotted **before**
mutation (`recordPrior`), then finalized per invoke into
`checkpoints/{id}/meta.json` plus prior-content blobs under
`checkpoints/{id}/files/`.

| Rule | Behavior |
|------|----------|
| First prior wins | Same path recorded once per invoke; later tools on that path reuse the original blob |
| Per-invoke session | `beginWriteCheckpoint` → tool `recordPrior` calls → `finalizeWriteCheckpoint` |
| Anchor index | `anchorUserMessageIndex` is the user message the invoke answered (already in `messages.jsonl`) |
| Auto-keep prior turns | On finalize, older unresolved checkpoints are marked kept so only the latest turn owns Keep/Discard UI |
| Soft no-op | `resolveWrites` with no open checkpoint returns empty success (UI may call after banner cleared) |

## Revert surfaces

| Surface | Effect | Starts agent? |
|---------|--------|---------------|
| Keep / Discard (per path or all) | Resolve latest (or named) checkpoint; discard restores blobs | No |
| Undo all | `undoWrites` — restore unresolved paths on latest undoable checkpoint | No |
| Edit message + resend | `prepareRewindAndReplaceUserMessage` + `rewindWritesFrom` + new invoke | Yes |
| Revert back (per user bubble) | `prepareRewindToUserMessage` + `chat:rewind` IPC; keep user text; truncate later turns | No |

IPC guards: run must be inactive (or cancelled first) for undo/resolve/rewind.

## Tool coverage matrix

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

Harness statement (`resources/harness/default.md`): workspace writes are checkpointed
for Keep/Discard; `plan.md` and `contract.md` run artifacts are not.

## Persistence layout

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

## Known limitations (intentional)

- Opaque shell/MCP mutations without parseable paths rely on the workspace
  mutation watcher (post Phase 2).
- Memory and run artifacts stay out of Keep/Discard by product choice.
- Partial blob restore failure leaves the checkpoint unresolved (`undoWrites`)
  so a retry can finish remaining paths.
- Legacy checkpoints without `anchorUserMessageIndex` are included when
  rewinding so later-turn writes are never left unrestored.

## Evidence

- `src/main/agent/checkpoints.ts` — checkpoint session, `recordPrior`, finalize
- `src/main/agent/rewindRun.ts` — `prepareRewindAndReplaceUserMessage`, `prepareRewindToUserMessage`
- `src/main/ipc/register.ts` — undo/resolve/rewind IPC guards
- `src/renderer/src/features/chat/components/ChangeSummary.tsx` — Keep/Discard UI
- `src/renderer/src/features/chat/components/UserPrompt.tsx` — Revert back control
- `resources/harness/default.md` — work style checkpoint statement
- `tests/main/unit/checkpoints.test.ts`
- `tests/main/unit/rewindRun.test.ts`
