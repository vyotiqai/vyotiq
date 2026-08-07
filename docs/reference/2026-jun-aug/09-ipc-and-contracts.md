# IPC and contracts

Zod-validated IPC between renderer, preload, and main process.

## Channel registry

`src/shared/ipc/channels.ts` — `IPC` object with **~120+ channel names** across domains:

| Domain | Examples |
|--------|----------|
| Workspace | `workspace:pick`, `workspaces:get`, `workspaces:add` |
| Settings / secrets | `settings:get`, `secrets:set` |
| Chat | `chat:start`, `chat:cancel`, `chat:followUp*`, `chat:rewind`, `chat:event` |
| Tool approval | `tool:approval-request`, `tool:approval-response` |
| Agent questions | `agent:question-request` |
| Runs | `runs:list`, `runs:undoWrites`, `runs:resolveWrites` |
| Harness | `harness:review`, `harness:apply` |
| Browser | `browser:navigate`, `browser:setBounds`, … |
| Git / PR | `git:status`, `git:commit`, `pr:view`, `pr:merge` |
| MCP / marketplace | `mcp:status`, `marketplace:browse`, … |
| PTY | `pty:create`, `pty:write`, `pty:resize` |
| Window / logs / telemetry | `window:minimize`, `logs:open-dir` |

Re-export: `src/shared/channels.ts` → `src/shared/ipc/channels.ts`.

## Schemas

`src/shared/ipc/schemas/` — Zod request/response per domain:

- `agent.ts` — chat start, follow-up, rewind, compact
- `browser.ts` — navigate, bounds, screenshot
- Git, settings, marketplace, runs, etc.

All `ipcMain.handle` wiring in `src/main/ipc/register.ts` validates with these schemas.

## Preload bridge

`src/preload/index.ts` — `contextBridge.exposeInMainWorld('vyotiq', api)`

Contract interface: `src/shared/vyotiqApi.ts` (`VyotiqApi`)

Renderer imports types from `@shared/vyotiqApi` — no direct `ipcRenderer` in renderer code.

## Stream batching

`src/main/ipc/streamBatch.ts` — `ChatEventBatcher` batches `chat:event` IPC to reduce renderer churn.

## Follow-up queue IPC (working tree)

New channels in working tree:

- `chat:followUp`, `chat:followUpRemove`, `chat:followUpUpdate`, `chat:followUpPromote`, `chat:queueMode`

Handled in `register.ts` via `enqueueFollowUp` (`runRegistry.ts`).

## Run file contract

Canonical transcript: `messages.jsonl` (one JSON per line).
Ops log: `events.jsonl` (append-only with ISO `at` timestamps).
Full tool output stored only in `messages.jsonl`.

Prefer `loadEventsAsync` / `flushEventAppends` on hot paths (see performance doc).

## Evidence

- `src/shared/ipc/channels.ts`, `src/shared/ipc/schemas/`
- `src/main/ipc/register.ts`, `src/main/ipc/streamBatch.ts`
- `src/preload/index.ts`, `src/shared/vyotiqApi.ts`
- `tests/main/integration/ipcContract.test.ts`
- `tests/main/unit/ipcRegister.test.ts`
- `tests/shared/ipcSchemas.test.ts`
