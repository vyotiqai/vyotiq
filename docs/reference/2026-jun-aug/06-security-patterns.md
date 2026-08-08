# Security patterns

Verified security controls in main process, agent tools, and renderer.

## Renderer sandbox

`src/main/app/window.ts` — `webPreferences`:

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- `webSecurity: true`

## CSP and navigation (`security.ts`)

- **CSP:** strict in production; relaxed only for Vite HMR dev (`ELECTRON_RENDERER_URL`)
- **External links:** `setWindowOpenHandler` denies in-app; `https://` only via `shell.openExternal`
- **Navigation lock:** `will-navigate` prevented when URL changes
- **Permissions:** `setPermissionRequestHandler` → `callback(false)`
- **Certificates:** `applyCertificateLogging` — never bypasses invalid certs (`callback(-3)`)

## Workspace path sandbox

`src/main/workspace/safePath.ts` — `resolveInsideWorkspace`:

- Rejects paths outside workspace root
- Symlink escape rejection via `realpathSync`
- String containment alone is insufficient

Marketplace paths: `src/main/marketplace/safePath.ts` — segment validation + `resolveInsideMarketplacePackages`.

Memory tools constrained to `.vyotiq/memory/` under workspace.

## Write guards

`src/main/agent/tools/writeGuard.ts`:

| Limit | Value |
|-------|-------|
| `LARGE_WRITE_MAX_CHARS` | 50,000 |
| `LARGE_WRITE_MAX_LINES` | 500 |
| Binary extensions | `.gguf`, `.bin`, `.zip`, `.tar`, `.gz`, `.safetensors`, `.pt`, `.onnx`, `.pth`, `.ckpt` |

## SSRF / URL blocking

**Agent browser tools** (`browser_navigate`, `browser_search`, etc.) accept any `http:`/`https:` URL including localhost and private networks — intentional full network access per product direction. URL normalization: `normalizeBrowserUrl` in `agentBrowser.ts`.

**Server-side fetch helpers** (`src/main/agent/tools/webFetch.ts`) — still used for marketplace catalog, provider HTTP, and MCP OAuth (not agent tools):

- `assertPublicUrl` blocks loopback/private ranges unless `allowLocal`
- DNS resolution pinned for connect (rebinding-resistant)
- `WEB_FETCH_MAX_BYTES = 2 MiB`

**Renderer external links** (`security.ts`): `https://` only via `shell.openExternal`; in-app navigation locked.

## Secrets

`src/main/settings/secrets.ts`:

- `safeStorage.encryptString` / `decryptString`
- `atomicWriteFile` mode `0o600`
- Settings redaction for IPC: `redactSettingsForIpc` in `settings.ts`

## Tool approval

`src/main/agent/toolApproval.ts`:

- User approval before risky tools
- `TOOL_APPROVAL_TIMEOUT_MS` = 900s (15 min)
- `browser_*` serial-only, always gated (`classify.ts`)
- MCP tools never approval-exempt in mutating/all modes

## IPC validation

All handlers in `src/main/ipc/register.ts` validate with Zod schemas from `src/shared/ipc/schemas/`.

## Other

- Single instance lock: `app.requestSingleInstanceLock()` in `src/main/index.ts`
- Markdown sanitization: `rehype-sanitize` dependency
- Terminal env sanitization: `sanitizedTerminalEnv` in `terminal.ts`
- MCP env sanitization: `sanitizeMcpEnv.ts`
- Logging scrubber: no workspace paths, commands, or chat payloads in telemetry

## Evidence

- `src/main/app/security.ts`, `src/main/app/window.ts`
- `src/main/workspace/safePath.ts`, `src/main/marketplace/safePath.ts`
- `src/main/agent/tools/writeGuard.ts`, `webFetch.ts`
- `src/main/agent/tools/classify.ts`, `toolApproval.ts`
- `src/main/settings/secrets.ts`, `settings.ts`
- `tests/main/unit/writeGuard.test.ts` (if exists), `webFetch` tests, `safePath` tests
