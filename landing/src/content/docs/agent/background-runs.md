---
title: Background and interrupted runs
description: Read run status, return to work that continued off-screen, and resume only the interrupted chat you open.
section: agent
order: 4
type: guide
audience: Long-running task users
related:
  - troubleshooting/runs-network-recovery
  - tools/notifications
  - concepts/runs-sessions-state
---

A run belongs to its chat, not to the currently visible panel. Switching chats or workspaces can leave work running in the background.

## Recognize run state

Sidebar rows and the transcript distinguish running, complete, failed, cancelled, and resumable interruption states. A background toast can direct you back to the affected chat. Notifications can also record Agent run finished, Agent run failed, or Agent needs you.

Opening another chat does not transfer the active run to that chat.

## When a run is interrupted

An interrupted run is persisted with a resumable marker. Opening that chat shows `Continue` unless [Settings → Tools](/docs/reference/settings#tools) → Auto-resume interrupted runs is enabled.

That setting applies only to the interrupted chat you open. It does not resume every interrupted run in the workspace.

Before continuing:

1. Read the last assistant text and tool rows.
1. Check Changes for writes that already landed.
1. Check Terminal sessions separately; an interactive PTY and an agent terminal call have different lifecycles.
1. Continue only if the original goal is still valid.

## Stop versus interruption

**Stop** or `Esc` cancels the live invocation. A network interruption, context cutoff, provider error, or application restart can instead leave a resumable run. The transcript's final status is the source of truth; do not infer completion from a quiet UI.

## Work safely in the background

Enable notifications if you want an inbox entry while another workspace is active. Keep tool approval enabled when a background run should pause before mutations. An approval or blocking question creates Agent needs you rather than silently choosing for you.

If `Continue` repeats without progress, or the run reports Connection lost, Temporarily paused, or a provider error, follow [Run, network, and recovery issues](/docs/troubleshooting/runs-network-recovery).
