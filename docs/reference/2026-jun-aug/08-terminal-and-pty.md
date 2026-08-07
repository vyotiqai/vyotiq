# Terminal and PTY

Two surfaces: agent **`terminal` tool** (spawn commands) and interactive **PTY dock** (xterm).

## Agent `terminal` tool

`src/main/agent/tools/terminal.ts`:

| Constant | Value |
|----------|-------|
| `TERMINAL_MAX_OUTPUT` | 64 KiB (stdout/stderr each) |
| `TERMINAL_MAX_TIMEOUT_MS` | 300s (5 min) |

- Shell resolution: `resolveTerminalShell`, `terminalSpawnSpec`
- Env sanitization: `sanitizedTerminalEnv`
- Output parsing: `parseTerminalOutput` from `src/shared/utils/terminalFormat.ts`
- Run-scoped sessions: `terminalSessions.ts`

Checkpointing: known-path parser + post-exec workspace mutation watcher (phased).

## Interactive PTY dock

`src/main/app/ptySessions.ts`:

- `createPtySession`, `writePty`, `resizePty`, `killPty`, `disposeAllPtySessions`
- Optional `node-pty` (Electron ABI); pipe-shell fallback if native module unavailable
- IPC: `pty:create`, `pty:write`, `pty:resize`, etc. (`channels.ts`)

Windows: prebuilds often work without local compile; source rebuild needs VS Build Tools with Spectre libs.

## Renderer UI caps

| Constant | Location | Value |
|----------|----------|-------|
| `TERMINAL_UI_MAX` | `createChatStreamController.ts` | 64 KiB |
| Terminal body | `TerminalBody.tsx` | Formatted output via `terminalFormat.ts` |

Shared formatting helpers added in working tree: `src/shared/utils/terminalFormat.ts`.

## Classification

`terminal` is **not** parallel-safe or approval-exempt in mutating mode.
`diagnostics` spawns shell — Plan-only, not Ask.

## Evidence

- `src/main/agent/tools/terminal.ts`, `terminalSessions.ts`
- `src/main/app/ptySessions.ts`
- `src/shared/utils/terminalFormat.ts`
- `src/renderer/src/lib/hooks/createChatStreamController.ts`
- `src/renderer/src/features/chat/toolUi/bodies/TerminalBody.tsx`
- `tests/shared/terminalFormat.test.ts`
- `tests/main/e2e/ptyLifecycle.test.ts`
- `tests/renderer/chat/useChatStream.test.tsx`
