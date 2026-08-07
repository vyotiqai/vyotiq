# Feature inventory

From `README.md` and verified code. Stack: Electron 43.2.0 · React 19 · TypeScript · Tailwind 4 · Zod IPC.

## Built-in tools (45 per README)

`read` · `edit` · `search` · `glob` · `grep` · `list_dir` · `multi_edit` · `str_replace` ·
`delete` · `todo_write` · `web_fetch` · `web_search` · `browser_navigate` · `browser_snapshot` ·
`browser_click` · `browser_type` · `browser_scroll` · `browser_fill` · `browser_tabs` ·
`browser_back` · `browser_forward` · `browser_wait_for_selector` · `browser_wait_for_url` ·
`browser_press_key` · `browser_select_option` · `mcp_list_tools` · `request_mcp_tools` ·
`release_mcp_tools` · `mcp_list_resources` · `mcp_read_resource` · `mcp_list_prompts` ·
`mcp_get_prompt` · `ask_question` · `switch_mode` · `terminal` · `memory_list` · `memory_read` ·
`memory_write` · `Skill` · `git_status` · `git_diff` · `git_commit` · `diagnostics` ·
`generate_image` · `edit_image`

Handlers: `BUILTIN_HANDLERS` in `src/main/agent/tools/index.ts`.
Schemas: 44 entries in `src/main/agent/schemas/tools.ts` tool registry.
Dynamic MCP tools: `mcp__<serverId>__<toolName>` at runtime.

## Interaction modes

| Mode | Write files | Terminal | MCP server tools | Image write |
|------|-------------|----------|------------------|-------------|
| Ask | No (read-only set) | No | No | Dry-run |
| Plan | Plan artifacts + diagnostics | No | No | Dry-run |
| Agent | Full (checkpointed) | Yes | Yes | Yes |

Mode overlay: `modeSectionMarkdown` in `modePolicy.ts`.

## Providers (10)

OpenAI · Anthropic · Gemini · Ollama · DeepSeek · Groq · OpenRouter · xAI · Mistral · Custom

- Extended thinking on reasoning-capable models
- OpenAI GPT-5.6+ prompt-cache breakpoints on system prefix
- Gemini Interactions API for thinking models
- Live model list via `models:list` (5-minute cache)

## UI panels

| Panel | Component | Purpose |
|-------|-----------|---------|
| Chat | `ChatView` | Transcript + composer |
| Browser | `AgentBrowserPanel` | Live `WebContentsView` |
| Terminal | PTY dock | Interactive shell |
| Changes | `ChangesPanel` | Git diff/stage |
| PR | `PrPanel` | GitHub PR via `gh` |
| Plan | Plan panel | `plan.md` artifact |
| Settings | `SettingsView` | Providers, agent, registry |
| Marketplace | `MarketplaceView` | MCP/skills/plugins |

## Context and memory

- Universal context pipeline: budget layers, compaction, workspace snapshot
- Memory at `{workspace}/.vyotiq/memory/` — **not RAG** (no embeddings)
- Tools: `memory_list`, `memory_read`, `memory_write`

## Agent loop

Entry: `runAgent` in `src/main/agent/loop.ts`

Supporting: `runRegistry`, `loopPolicy`, `streamRetry`, `networkMonitor`, `toolApproval`,
`checkpoints`, `rewindRun`, MCP client, provider adapters.

## Slash commands / builtins

Harness review/apply, compaction, mode switch, marketplace, git operations — via IPC and slash registry.

## Evidence

- `README.md`
- `src/main/agent/tools/index.ts`, `schemas/tools.ts`
- `src/main/agent/tools/modePolicy.ts`
- `src/main/agent/providers/`
- `src/renderer/src/features/`
- `src/shared/ipc/channels.ts`
