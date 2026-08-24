---
title: Run, network, and recovery issues
description: Diagnose offline queues, interrupted turns, repeated Continue states, provider cutoffs, and crash recovery.
section: troubleshooting
order: 2
type: troubleshooting
audience: Users with failed runs
owner: Vyotiq product
lastVerified: 1.0.0
sources:
  - src/renderer/src/lib/hooks/useOfflineSendQueue.ts
  - src/renderer/src/features/chat/SessionChatColumn.tsx
  - src/shared/errors.ts
  - src/main/logging/crashDiagnostics.ts
related:
  - agent/background-runs
  - tools/notifications
  - reference/storage
---

## Message waits while offline

Agent V can queue a send while connectivity is unavailable. Keep the chat open until the connection state changes. Do not press send repeatedly; duplicate prompts can become separate invocations after recovery.

Offline wait behavior uses default, extended, or wait forever. Wait-forever is available only with Autonomous mode.

## The transcript shows Continue

The previous invocation ended without a complete result. Reasons include truncation, empty or filtered response, context overflow, network interruption, circuit-open protection, or provider error.

1. Read the last assistant and tool rows.
1. Inspect Changes for writes already applied.
1. Confirm the original goal is still valid.
1. Choose Continue once.

If Auto-resume interrupted runs is on, opening this chat resumes it automatically. Other interrupted chats are not resumed.

## Continue repeats

Do not loop blindly. Note the incomplete reason:

- Context overflow: compact history or start a fresh chat.
- Network interruption: verify host reachability.
- Circuit open: allow the provider failure window to clear, then retry.
- Provider error: inspect key, quota, model, and provider message.
- Empty or filtered response: choose a suitable model or reformulate the request.

## Application recovered after a crash

Open [Settings → General](/docs/reference/settings) → Recent crashes and Open logs folder. Capture the timestamp, process type, reason, and exit code. Reopen the affected chat and inspect persisted state before continuing.

## Safe recovery boundary

Do not delete run storage before collecting evidence. Do not kill broad Electron, Node, or pnpm process groups. Use Stop for the named live run, close the named terminal session, or restart the app normally.

Escalation evidence: app version, platform, run ID, provider/model, exact final status, last successful tool, local log excerpt, and whether the working tree changed.
