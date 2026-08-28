---
title: Long-lived goals
description: Keep a chat working an objective until complete, pause or resume it, and arm a prompt loop.
section: agent
order: 9
type: guide
audience: Long-running task users
related:
  - agent/modes
  - customize/slash-commands
  - reference/tools
---

A goal is a run-scoped objective stored in `goal.json`. It is not the sidebar chat title (`status.goal`). Prefer a new chat. `/goal` forces Agent mode.

## Set and complete a goal

Type `/goal fix all flaky tests and make CI green`. The composer sends a skill-style instruction and the run writes `goal.json` immediately from that header so the banner appears even before the model calls `create_goal`. Work continues until `update_goal` with status `complete` or you pause.

The agent can call `create_goal` only when you explicitly asked for a goal, and `update_goal` with `active` (resume after a pause) or `complete`. It cannot pause. Completing a goal disarms an armed loop. Stopping the loop does not complete the goal.

Inline instances omit these tools. The root chat owns the goal. Plan and Agent may use the tools; Ask may not.

The chat banner shows the objective and Pause, Resume, and Mark complete. Sidebar rows show a flag while the goal is active or paused.

## Pause, stop, and restart

Pause from the banner or `/goal pause`. Stop or Esc on an active goal pauses it and disarms the loop so auto-continue cannot restart immediately. `/goal resume` or the banner Resume button starts a new invocation with a continuation message.

Auto-continue runs only in Agent mode after a genuine finish (not truncated or incomplete). Follow-ups still win. Two consecutive finishes without tools, and without `update_goal` complete, stop auto-continue, keep the goal active, and wait for you.

Closing the app with an **active** (not paused) goal resumes it after restart for currently open workspaces, with a toast `Resuming goal: …`. That is separate from auto-resume of an interrupted chat you open.

## Prompt loops

`/loop [interval] <prompt>` arms a main-process timer on this chat (`30s`, `5m`, `2h`, `1d`; minimum 30 seconds, maximum 24 hours). `/loop` with no arguments shows the current timer. `/loop stop` or Stop loop on the banner disarms it. While the app is open, each tick queues a follow-up if the run is live, or starts a new invocation with that prompt.
