---
title: Product tour
description: Find workspaces, chats, the transcript, composer controls, and the six task panels.
section: start
order: 3
type: guide
audience: New and returning users
owner: Vyotiq product
lastVerified: 1.0.0
sources:
  - src/renderer/src/features/chat/ChatView.tsx
  - src/renderer/src/app/sidebar/Sidebar.tsx
  - src/renderer/src/features/chat/components/ChatSideRail.tsx
  - src/renderer/src/features/chat/components/DockTabBar.tsx
  - src/renderer/src/features/chat/components/MessageList.tsx
  - src/renderer/src/features/chat/components/composer/ComposerPlusButton.tsx
related:
  - agent/workspaces-sessions
  - reference/layout
  - reference/shortcuts
---

Agent V has three top-level views: chat, Settings, and Marketplace. Chat combines navigation, a run transcript, the composer, and optional task panels.

## Sidebar

The sidebar contains workspace tabs and each workspace's chat list. Use `Add workspace`, New chat, and Search chats here. The Settings and Marketplace entries switch the whole main view; they are not chat panels.

Workspace and chat are different boundaries. A workspace selects the project folder. A chat selects a persisted run history inside that workspace.

## Transcript and run header

The center column shows user prompts, assistant replies, thinking blocks when enabled, tool groups, approvals, questions, and run status. When a reply cites this-run file or web evidence, numbered superscripts in the prose map to compact source chips under that reply. The session bar can open another chat without changing workspace.

A running or interrupted chat can remain visible in the sidebar. Opening an interrupted chat either shows Continue or resumes automatically when Auto-resume interrupted runs is enabled.

## Composer

The composer exposes:

- Mode: Ask, Plan, or Agent.
- Model picker: configured providers and their models.
- Think: shown when the selected model supports reasoning controls.
- Context: usage and Compact history.
- Add (+): attach files, images, and audio.
- Mic: dictation configured in [Settings → Voice](/docs/tools/voice-dictation).
- /: commands, skills, and MCP. /ask, /plan, and /agent still work if you type them.
- @: workspace and run context.
- Stop: shown during a live run.

## Six task panels

The dock rail opens six real work surfaces:

1. Files — workspace tree, editor tabs, save and recovery actions.
1. Browser — embedded tabs shared with browser tools.
1. Terminal — interactive shell sessions.
1. Changes — Git status, diffs, and checkpoint Keep/Discard.
1. Pull Request — GitHub CLI authentication and pull-request review.
1. Plan — run plan, contract, todos, and Continue in Agent.

Panels can be shown or hidden without ending the current run. Some have direct shortcuts; see Keyboard shortcuts.

## Settings and Marketplace

Settings has ten sections, from General through About. Marketplace has Browse and Manage; Manage separates **MCPs**, **Skills**, **Rules**, and **Packages**. Use the focused documentation for those systems instead of treating Marketplace as one install list.
