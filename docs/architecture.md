# Architecture

Detailed architecture reference lives at
[docs/reference/2026-jun-aug/15-architecture.md](./reference/2026-jun-aug/15-architecture.md)
(process boundaries, aliases, persistence, invoke flow).

Quick layout from `README.md`:

```
src/main/          # window, security, IPC, secrets, agent loop / tools / providers
src/preload/       # contextBridge API
src/shared/        # Zod IPC contracts, channels, domain models
src/renderer/      # React UI (sidebar + chat + settings)
resources/harness/ # system agent harness (default.md)
```

Run state under AppData: `{userData}/workspaces/{workspaceId}/sessions/{runId}/`.
Project memory: `{workspace}/.vyotiq/memory/`.
