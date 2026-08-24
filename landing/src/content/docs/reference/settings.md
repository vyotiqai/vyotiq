---
title: Settings reference
description: Exact controls, options, defaults, and scope across all ten Settings sections.
section: reference
order: 1
type: reference
audience: Administrators and support
owner: Vyotiq product
lastVerified: 1.0.0
sources:
  - src/renderer/src/features/settings/constants.ts
  - src/renderer/src/features/settings/settingsSearchIndex.ts
  - src/renderer/src/features/settings/sections
  - src/shared/ipc/schemas/settings.ts
related:
  - customize/providers
  - tools/indexing
  - tools/voice-dictation
---

Open Settings from the sidebar, /settings, or Open settings (Ctrl+, / ⌘,). Search jumps to a field. This page lists section titles and the labeled controls. Schema-only flags with no Settings row are omitted.

## General

| Control | Options and notes |
| --- | --- |
| Active model | opens the composer model picker, or jump to Providers. Workspace Override can pin a different provider/model per folder |
| Workspaces | open workspace tabs. `Add workspace`. Enable Override for per-workspace provider, model, and agent settings. Override seeds thinking, compaction, and approval from global defaults when first enabled |
| Share crash & error reports | optional opt-in. Local rotating logs are always written. Unavailable in builds with no Sentry DSN. Never includes chat contents, API keys, or file bodies |
| Enable notifications | master switch for the inbox and desktop toasts |
| Desktop notifications | Off, When unfocused, Always |
| Logs | Open logs folder (local rotating files) |
| Recent crashes | last renderer / GPU / utility process exits |
| Diagnostics command | optional override for the diagnostics tool typecheck. Blank = auto-detect (package scripts or tsc) |

## Appearance

| Control | Options and notes |
| --- | --- |
| Color mode | System, Dark, Light |
| Text size | Small, Default, Large |
| UI density | Compact, Default, Comfortable |
| Accent color | Neutral, Blue, Violet, Green |

## Providers

See [Providers](/docs/customize/providers). **Active provider**, API keys, `Refresh models`, Ollama base URL, Custom **OpenAI** base URL.

## Agent

| Control | Options and notes |
| --- | --- |
| Show thinking in chat | collapsed thinking blocks above assistant replies |
| Keep recent turns | 4–50 turns preserved during compaction |
| Auto-compact threshold | 5–95% of the model content window |
| Workspace rules | loaded from AGENTS.md, CLAUDE.md, .cursorrules, and .vyotiq/rules/. Edit in Marketplace → Manage → **Rules** |
| Memory files | {workspace}/.vyotiq/memory/ markdown. See Memory files |

## Indexing

See Codebase search and indexing. Enable codebase index, Embedder (LightOn dense (mDenseOn / ONNX), Ollama, **Local** hash), Auto-download model, Ollama embedding model, Index status, Reindex workspace.

## Voice

| Control | Options and notes |
| --- | --- |
| Dictation engine: **OpenAI**, **OpenRouter**, **Local**. **OpenAI** and **OpenRouter** use gpt-transcribe and need that provider’s key in Providers. **Local** runs Whisper on this machine (English). **Local** stays disabled until a Whisper model is installed. Install does not switch the engine by itself. Engine is read on each mic stop | no restart. |
| Waveform: Bars, Dots, Line, Mirror | listening visualizer in the composer. Does not change transcription. |
| **Local** models | Whisper Tiny (Fast, English, ~41 MB) and Whisper Small (Recommended, English, ~249 MB). Buttons: Install Whisper Tiny, Install Whisper Small, Unload Whisper Tiny, Unload Whisper Small, Delete Whisper Tiny cache, Delete Whisper Small cache. The mic does not require an **OpenAI** key. |

## Tools

See Security and approval, Browser, and Terminal. `Tool approval`, Terminal shell, Browser domain allowlist, Search engine, Auto-resume interrupted runs, Automatic mode switching.

## Integrations

| Control | Options and notes |
| --- | --- |
| GitHub client ID | Connect GitHub in the PR panel |
| LLM harness proposal rewriter | experimental, default off. When on, /harness-review may rewrite the proposed default.md body via the configured model. Apply stays human-confirm |

## Shortcuts

Read-only list of chords. They are not rebindable. Full list: Shortcuts.

## About

Version, Electron / Chromium / Node.js, platform, Copy build info, Website, and Docs (opens this site at /docs).
