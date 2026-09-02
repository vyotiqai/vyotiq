---
title: Workspaces, chats, tabs, and split panes
description: Understand the four containers Agent V can open and what closing each one changes.
section: agent
order: 3
type: concept
audience: Multi-project users
related:
  - concepts/runs-sessions-state
  - agent/background-runs
---

Agent V exposes several kinds of tabs. They are related, but they do not represent the same state.

## Workspace

A workspace is the project folder and the top-level isolation boundary. `Add workspace` opens another folder as a workspace tab. Workspace-specific overrides can change provider, model, thinking, compaction, tool approval, and Marketplace enablement for runs in that folder.

Closing a workspace tab removes it from the current open set; persisted sessions remain in the app-data workspace record.

## Chat

A chat is one persisted run history within a workspace. The sidebar lists these histories and their current state. New chat starts a clean task boundary. Use it when the next task should not inherit earlier messages.

Deleting or cleaning up a chat is different from closing a visible tab. Treat removal actions as data operations and read their confirmation text.

## Chat tab

The sidebar chat list and split panes keep multiple chats visible inside one workspace. New chat starts another session. Closing a chat tab or pane removes it from the visible set but does not delete the persisted run.

Use Ctrl+W / ⌘W to close the active chat tab when focus is in the chat surface.

## Split pane

The chat pane host can display sessions in separate panes. A split is a layout choice over open chats; it does not clone a run or create an agent instance. Each pane retains its own selected chat.

## Choose the right boundary

- Different project folder: open another workspace.
- Unrelated task in the same project: start a new chat.
- Compare or monitor two chats: open another chat in the sidebar or split a pane.
- Delegate independent implementation with a child run: use an Agent instance.

Runs continue according to their run state, not according to which pane is visible. Review Background and interrupted runs before closing a view while work is active.
