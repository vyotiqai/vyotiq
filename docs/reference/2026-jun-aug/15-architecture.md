# Architecture

Fills the missing `docs/architecture.md` link from `README.md`.
Substitute path: this file in the reference folder.

## Process model

Electron three-process split:

```
src/main/       Main process — window, IPC, agent loop, tools, providers
src/preload/    contextBridge — exposes window.vyotiq
src/renderer/   React UI — sidebar, chat, settings, marketplace
src/shared/     Cross-process types, IPC schemas, domain models
```

Entry: `src/main/index.ts` → `registerIpc`, window creation, MCP sync, migrations.

Build output: `out/main/index.js` (`package.json` main field).

## Path aliases

From `electron.vite.config.ts` and `vitest.config.ts`:

| Alias | Path |
|-------|------|
| `@main` | `src/main` |
| `@shared` | `src/shared` |
| `@renderer` | `src/renderer/src` |

TypeScript projects:

- `tsconfig.node.json` — main, preload, shared
- `tsconfig.web.json` — renderer, shared types

## Main process modules

| Folder | Responsibility |
|--------|----------------|
| `agent/` | Loop, tools, providers, MCP, context, checkpoints, harness |
| `app/` | Window, browser (`agentBrowser`), PTY, security, shortcuts |
| `ipc/` | `registerIpc`, stream batching |
| `settings/` | Settings + secrets (`safeStorage`) |
| `workspace/` | Workspace tabs, safe paths |
| `git/` | Status, diff, commit, GitHub auth, `gh` PR |
| `marketplace/` | Catalog, install, MCP resolve |
| `storage/` | Run persistence, migrations |
| `perf/` | Opt-in load/IPC timing |
| `logging/` | electron-log, crash logging |

## Renderer structure

```
src/renderer/src/
  app/           Shell, sidebar, title bar
  features/
    chat/        ChatView, composer, tool UI, dock panels
    settings/    Settings sections
    marketplace/ Marketplace views
  lib/
    hooks/       useChatStream, createChatStreamController, etc.
    icons/       Icon registry
    ui/          Shared UI primitives (NavItem, etc.)
    utils/       layout, dockPanels
  styles.css
```

## Shared layer

- `shared/ipc/` — channel names + Zod schemas
- `shared/domain/` — context budget, message types
- `shared/utils/` — run telemetry, terminal format, workspace paths
- `shared/vyotiqApi.ts` — preload/renderer API contract

## Data persistence

### AppData (`{userData}/`)

```
workspaces.json
settings.json
secrets.json
logs/
workspaces/{workspaceId}/
  meta.json
  sessions/{runId}/
    messages.jsonl
    events.jsonl
    status.json
    contract.md
    plan.md
    receipt.json
    checkpoints/
```

### Workspace-local

```
{workspace}/.vyotiq/memory/     Long-term agent memory
{workspace}/resources/harness/default.md   Optional harness override
```

## Agent invoke flow

```mermaid
sequenceDiagram
  participant UI as Renderer
  participant IPC as registerIpc
  participant Loop as runAgent
  participant Ctx as assembleContext
  participant Tools as executeTool
  participant Prov as Provider

  UI->>IPC: chat:start
  IPC->>Loop: runAgent
  Loop->>Ctx: assembleContext
  Loop->>Prov: stream completion
  Prov-->>Loop: tool calls
  Loop->>Tools: executeTool
  Tools-->>Loop: tool results
  Loop-->>IPC: chat:event batch
  IPC-->>UI: stream updates
```

## Bundled resources

Packaged via `electron-builder.yml`:

- `resources/harness/` — default agent harness
- `resources/marketplace/` — bundled skills/plugins
- `resources/branding/`

## Security boundaries

- Renderer: sandboxed, no Node integration
- All file access: workspace-root sandbox + symlink checks
- Secrets: main process only, encrypted storage
- Browser: separate session partition, URL SSRF checks

## Composer variant contract

README references composer variant conventions in architecture doc — verified
locations:

- `Composer.tsx` — main composer
- `ComposerToolbar.tsx`, `ThinkingControls.tsx`, `ContextMeter.tsx`
- Mode and model picker integrated in composer feature folder

## Evidence

- `README.md` — layout section
- `electron.vite.config.ts`, `tsconfig.*.json`
- `src/main/index.ts`, `src/main/ipc/register.ts`
- `src/main/agent/loop.ts`, `src/main/agent/context/assemble.ts`
- `docs/harness-handbook.md` — run-file contract
