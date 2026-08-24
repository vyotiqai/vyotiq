---
title: Runs, sessions, and state
description: Learn how chats, invocations, artifacts, receipts, instances, interruption, and cleanup relate on disk.
section: concepts
order: 2
type: concept
audience: Users and support
related:
  - agent/workspaces-sessions
  - agent/background-runs
  - reference/storage
---

A workspace, chat, run, and invocation are different levels of state.

## Workspace record

Agent V derives a stable workspace ID from the canonical project path. Under app data, that workspace record contains metadata, sessions, the semantic index, and the sparsegrep index.

## Chat and run

A chat selects one persisted run directory. Its transcript and status survive switching panes and application restarts. The run status records running, cancelled, error, or done, plus the step, update time, mode, workspace, and resumable interruption state.

## Invocation

Each send starts a new invocation in the existing run. An invocation ID separates live events from late events belonging to the previous turn. Continue starts another invocation from persisted state; it does not rewrite the earlier transcript.

## Run artifacts

A run can contain:

- transcript messages and event history;
- status;
- contract.md and plan.md;
- todo state;
- checkpoint records;
- tool outputs and summaries;
- receipt.json with structured activity and write information.

The renderer can show shortened tool output while full persisted output remains in run storage.

## Child instances

An inline Agent instance has its own run ID and parent run ID. It can also record a path scope, worktree path, and worktree branch. Child runs are hidden from the normal top-level list and appear under the parent workflow.

## Interruption and cleanup

An orphaned or interrupted run can be marked resumable with an interruption timestamp. Opening that specific chat shows Continue or triggers its configured auto-resume.

Deleting or cleaning a persisted run is a data operation, not the same as closing a tab. Before cleanup, confirm the run no longer contains the only copy of a plan, transcript, receipt, or evidence needed for support.
