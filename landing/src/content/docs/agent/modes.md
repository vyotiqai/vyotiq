---
title: Choose Ask, Plan, or Agent
description: Match the mode to the job and understand exactly which actions each mode permits.
section: agent
order: 1
type: guide
audience: All agent users
related:
  - agent/plans-todos-questions
  - reference/tools
  - concepts/security
---

The mode is an enforced tool boundary, not only a prompting hint.

## Decision guide

| Need | Mode | Boundary |
| --- | --- | --- |
| Explain code, inspect state, compare options | Ask | Read-only built-ins and browse-only browser actions |
| Investigate and produce an approval-ready plan | Plan | Read tools, todos, diagnostics, run_tests, and only run plan.md/contract.md edits |
| Change files, run commands, interact with sites, or write memory | Agent | Full built-in catalog, subject to approval and safety gates |

MCP server tools are Agent-only. Ask and Plan can list MCP catalogs, but cannot invoke server tools, read resources, or fetch prompts.

## Use Ask

Choose Ask for questions such as “Where is authentication initialized?” or “What would break if this type changed?” Ask can read, search, inspect Git status and diffs, use Skill, and browse without click/type/fill mutations. It cannot run terminal commands, diagnostics, edits, or memory writes.

## Use Plan

Choose Plan when the implementation has meaningful choices or spans multiple systems. Plan can update the current run's plan.md and contract.md, maintain todos, and run the configured diagnostics check. It cannot edit product files or use the terminal.

When the plan is approved, select Agent or use Continue in Agent in the Plan panel.

## Use Agent

Choose Agent when the requested outcome requires edits, commands, Git operations, browser interactions, MCP calls, memory writes, or agent instances. `Tool approval` can still stop gated actions for review.

## Switching modes

Use the composer picker, Ctrl+. / ⌘., or /ask, /plan, and /agent.

Automatic mode switching in [Settings → Tools](/docs/reference/settings#tools) is off by default. When enabled, `switch_mode` becomes available and a live run can change mode at the next step boundary. When disabled, only you can switch.

Changing mode does not create a new chat. Start a new chat for an unrelated task so stale context does not carry forward.
