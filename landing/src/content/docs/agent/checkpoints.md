---
title: Checkpoints and undo
description: Review agent writes, keep or discard a checkpoint, and understand what checkpoints do not recover.
section: agent
order: 6
type: guide
audience: Users reviewing edits
related:
  - tools/changes-git
  - customize/slash-commands
  - concepts/security
---

Agent V records workspace-write checkpoints for agent edits. They support review and rollback inside a run; they are not Git commits and do not replace a backup.

## Review a checkpoint

1. Open [Changes](/docs/tools/changes-git) after an Agent step writes files.
1. Inspect the changed-file list and diff.
1. Run the relevant verification before accepting the state.
1. Choose Keep to accept the checkpointed state or Discard to restore that checkpoint.

Keep and Discard apply to the checkpoint represented by the UI. Read the confirmation and current diff before using either action.

## Undo the last agent writes

/undo invokes Undo agent writes for the current run. Its built-in description is “Restore files from the last agent write checkpoint for this run.”

Use it only after identifying which run made the writes. A different chat has a different checkpoint history.

## What a checkpoint covers

Checkpoints track workspace writes made through the agent's guarded write path. They do not promise to reverse:

- arbitrary side effects from terminal commands;
- external services changed through a browser or MCP server;
- Git pushes or remote pull-request actions;
- edits made by another application after the checkpoint;
- generated package trees excluded from normal source handling.

The Files editor's Discard/Reload is also different: it abandons one editor buffer or reloads an externally changed file.

## Use Git for durable history

After a checkpoint is kept and verified, use Git status and diff to review the repository-wide state. Commit only when you intend to create durable version history. Checkpoint Keep does not stage or commit.

If rollback reports an external conflict, stop and inspect the working tree. Do not overwrite newer work merely to make the checkpoint UI clear.
