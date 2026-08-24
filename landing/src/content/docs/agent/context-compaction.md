---
title: Context and compaction
description: Read the context meter, understand its estimates, and compact a long chat without treating summaries as lossless.
section: agent
order: 5
type: concept
audience: Long-chat users
owner: Vyotiq product
lastVerified: 1.0.0
sources:
  - src/renderer/src/features/chat/components/composer/ContextMeter.tsx
  - src/main/agent/compactRun.ts
  - src/main/agent/context/compact.ts
  - src/renderer/src/features/settings/sections/AgentSection.tsx
related:
  - customize/models
  - agent/prompting-attachments
  - troubleshooting/runs-network-recovery
---

Context is the model input assembled for the next step. It includes more than visible chat text: system instructions, workspace rules, recent messages, attachments, tool results, and compacted history can all consume the model window.

## Read the Context control

The composer Context meter is an estimate against the selected model's known content window. Open it for the category breakdown and Compact history.

Model catalogs and local metadata can report different windows. The meter is planning information, not a promise that a provider will accept one more turn.

## Automatic compaction

Settings → Agent controls:

- Keep recent turns: 4–50 turns preserved when older history is summarized.
- Auto-compact threshold: 5–95% of the model content window.

When the estimated threshold is reached, Agent V can compact older history and retain recent turns. Compaction produces a summary for later steps; it does not preserve every original token.

## Compact manually

Use Compact history from the meter or /compact.

1. Finish or stop the current live step.
1. Read any unreviewed tool output first.
1. Compact.
1. Confirm that the transcript reports the result.
1. In the next prompt, restate any exact acceptance criterion that must survive summarization.

## When to start a new chat

Start a new chat when the task changes, earlier assumptions are no longer useful, or exact detail is more important than continuity. /clear starts a fresh chat and is safer than carrying an unrelated task through repeated summaries.

## Failure boundaries

Compaction can be rejected when the run state or source history changed while the summary was being produced. That protects against installing a summary of stale history. If compaction fails, leave the current history intact, retry after the run settles, or start a new chat.

Do not use memory files as an automatic substitute for context. Memory is explicit workspace Markdown that the agent reads or writes through memory tools.
