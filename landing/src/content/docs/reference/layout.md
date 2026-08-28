---
title: UI and panel reference
description: Stable names and responsibilities for the sidebar, transcript, composer, sessions, and six dock panels.
section: reference
order: 5
type: reference
audience: Support and new users
related:
  - start/product-tour
  - reference/attachments
  - reference/shortcuts
---

Three app views: chat, settings, marketplace. Chat is sidebar + transcript + composer + optional docks.

## Sidebar

Workspace tabs, chat/run list, `Add workspace`, Settings, Marketplace. Open a workspace first gates chat until a folder is selected. Search chats (Ctrl+K / ⌘K). New chat (Ctrl+N / ⌘N).

## Composer

Placeholder depends on mode and whether a run is live. See Quickstart.

- Mode — Ask / Plan / Agent
- Model picker — configured providers plus the current active provider; Speed (Default / Flex / Fast) when the model supports service tiers
- Think — effort control when the model supports thinking
- Context meter — usage ring; open for breakdown and Compact history
- Stop — while running (Esc)
- / — slash commands
- @ — mentions (below)
- Attach — files, images, audio (limits below)
- Mic — dictation ([Settings → Voice](/docs/tools/voice-dictation))

### @ mentions

| Control | Options and notes |
| --- | --- |
| Root menu (workspace selected) | Branch, Browser, Typecheck, Lint, recent files, Files & Folders, Docs, **Rules**, Past Chats. |
| Docs here means README and project docs in the workspace | not this website. Product docs are /docs on the landing site (header Docs, and Settings → About → Docs). |

### Attach

Up to 5 files, 4 images, and 2 audio files. Files and native attachments cap at 8 MB. Images cap at 12 MB. Audio caps at 16 MB. See Attachment limits and formats.

## Voice dictation

[Settings → Voice](/docs/tools/voice-dictation). Engines: **OpenAI**, **OpenRouter**, **Local**, **Qwen3-ASR (local server)**, **Qwen3-ASR (on-device)**.

**OpenAI** and **OpenRouter** use gpt-transcribe and need that provider’s API key. **Local** is Whisper (English, Tiny/Small) and stays disabled until a model is installed. The mic does not require an **OpenAI** key. Shortcut Dictation (Ctrl+M / ⌘M).

## Dock panels

Six docks:

- Files — tree + editor (not a Memory panel)
- Browser — embedded agent browser
- Terminal — interactive PTY
- Changes — git working tree + Keep/Discard
- Pull Request — gh + Connect GitHub
- Plan — plan.md / contract.md / todos; Continue in Agent when ready

Show/hide from the dock rail. Shortcuts: Files (Ctrl+Shift+E / ⌘⇧E), Browser, Terminal, Changes, Pull Request (Ctrl+Shift+G / ⌘⇧G), Plan (Ctrl+Shift+D / ⌘⇧D).
