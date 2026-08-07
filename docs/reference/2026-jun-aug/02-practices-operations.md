# Operational practices and verification

Source: `docs/agent-practices-2026.md` §6–7, `AGENTS.md`.

## Audit-verified operational practices

| Practice | Decision / behavior |
|----------|---------------------|
| Mid-session stale running reconciliation | `reconcileStaleRuns` (2 min age) on `listRuns`; boot `interruptOrphanRuns` with `maxAgeMs: 0` |
| Compaction retained decisions | Persist on `CompactionRecord`; reinject via `loopHint` until present in kept messages |
| LOOP_SAFETY streak | Resets on new invoke; do not carry `consecutiveToolFailureSteps` across invokeIds |
| Status / receipt flush | Status step patches flush immediately; receipt cadence decoupled from per-step artifacts |
| MCP pin / admit | Agent mode only; allowlist/denylist; `request_mcp_tools` / `release_mcp_tools` for schema budget |
| Atomic writes | Prefer rename-based persistence for meta/index (`atomicWriteJson`) |
| CCE search | Prefer `context_search` over whole-file reads when exploring; `session_recall` before non-trivial answers |
| Dev launch | Unset `ELECTRON_RUN_AS_NODE` in IDE shells; kill orphan `electron.exe` before relaunch |

## CCE (Code Context Engine)

From `AGENTS.md` / `.cursorrules`:

- Use `context_search` instead of reading whole files when exploring.
- `expand_chunk`, `related_context`, `session_recall` for deeper context.
- `record_decision`, `record_code_area` after meaningful work.

Project MCP config: `.cursor/mcp.json` lists `context-engine` server.

## Local dev launch

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm dev    # HMR
pnpm start  # production preview
```

**IDE shell:** unset `ELECTRON_RUN_AS_NODE` before launch:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

Without this, Electron boots as plain Node and crashes with
`Cannot read properties of undefined (reading 'isPackaged')`.

**Orphan processes:** killed dev shells can leave `electron.exe` holding the Vite
port; stop them before relaunch or the window renders blank.

## Verification gate

After checkpoint or rewind changes:

```bash
pnpm typecheck
pnpm test
pnpm lint
```

### Manual smoke (checkpoint / rewind)

1. Edit → Discard
2. Terminal write → Discard
3. MCP filesystem write → Discard
4. Edit-and-resend rewind
5. Bubble Revert back
6. Reload Keep/Discard card from `events.jsonl`

## Evidence

- `src/main/agent/state.ts` — stale reconciliation (`reconcileStaleRuns`), orphan interrupt
- `src/main/agent/runRegistry.ts` — follow-up queue
- `src/main/agent/loop.ts` — LOOP_SAFETY, compaction hints
- `src/main/agent/loopPolicy.ts` — streak limits
- `src/main/agent/networkMonitor.ts` — offline wait
- `AGENTS.md`, `.cursorrules`
- `tests/main/unit/runRegistry.test.ts`
- `tests/main/unit/agentLoopFollowUp.test.ts`
