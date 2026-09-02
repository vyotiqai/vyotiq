---
title: Questions, todos, and plans
description: Respond to blocking forms, follow live task state, and move an approved run plan into Agent mode.
section: agent
order: 8
type: guide
audience: Plan and long-task users
related:
  - agent/modes
  - agent/goals
  - reference/tools
---

Agent V gives long tasks three structured surfaces: questions for missing decisions, todos for live progress, and run plan artifacts for approved work.

## Answer a question

`ask_question` renders a typed form in the transcript. A question can accept one choice, multiple choices, a boolean, or text. The run waits for an answer, a skip, or its timeout.

Read every item before submitting because the answer becomes run input. If the question concerns a destructive or product-shape decision, do not guess from an earlier prompt.

With Autonomous mode enabled, Autonomous questions decides whether unattended runs skip immediately or wait for the normal question timeout.

## Read the todo state

`todo_write` updates the task list for the current run. The task band reflects pending, in-progress, completed, and cancelled items. At most one item should be in progress.

Todos communicate execution state; they are not durable project issues and do not replace verification. A completed todo means the agent marked that work complete, not that an external check necessarily passed.

## Use the Plan panel

Plan mode can write plan.md and contract.md inside the run artifact directory. The panel displays those artifacts and the live todo state.

A draft plan covers three sections: Goal (desired result), Steps (ordered phases), and Done when (how finished work is checked). Copy Done when into Contract Done when so Agent mode can check them. Use the question form for blocking decisions. Todos track execution; they do not replace Steps or Done when.

1. Ask for a plan in Plan mode.
1. Review Goal, Steps, and Done when.
1. Confirm Done when matches Contract Done when.
1. Request corrections while still in Plan.
1. Approve by selecting Agent or Continue in Agent. That button appears when the draft has real content beyond the empty template.
1. Keep the same run when the implementation should use the approved artifacts.

Plan mode cannot edit product source. diagnostics is available there because it runs the configured process check, but terminal commands and normal file mutations remain Agent-only.

## Receipts

Run storage can include a structured receipt describing tool activity, failure clusters, and files written. Receipts support later inspection and harness review; they do not replace the transcript, Git diff, or test output.
