# Harness handbook

Operational reference for the Agent V system harness: prompt assembly, the run-file contract, and the review/apply loop. Audience: maintainers. The harness itself stays short — behavioral policy only — so the run-time and meta-assembly documentation lives here instead.

## How the system prompt is assembled

Per invoke, the main process assembles the system prompt in `src/main/agent/context/assemble.ts`:

1. **Harness** — `loadHarness` (`src/main/agent/harness.ts`) prefers the workspace copy `resources/harness/default.md` when present and well-formed (non-empty, contains a markdown heading), else the bundled copy, else a one-liner fallback. It is loaded once per invoke, so applied edits take effect on the next invoke / new run, never mid-step.
2. **Stable prefix** — harness + workspace rules + skills / plugin-rule Level-1 metadata (name + description only, capped shares of the system budget) + run contract + plan. The prefix is fingerprinted (`stableSystemFingerprint`) so providers can cache it; OpenAI GPT-5.6+ and Anthropic send explicit cache breakpoints on it (`systemZones.ts`).
3. **Mode section** — `modeSectionMarkdown` (`src/main/agent/tools/modePolicy.ts`) contributes the Ask / Plan / Agent overlay that governs which tools are offered this turn; mode-specific tool rules live there, not in the harness.
4. **Volatile suffix** — per-step data that must not bust the cache: clock, workspace snapshot, memory index/state, loop hints, compaction summary.

## What belongs in `resources/harness/default.md`

- Behavioral policy only: role, capabilities, tool policy, constraints, work style, memory, output format.
- Keep it short and imperative. Per-tool how-to lives in the tool definitions (`src/main/agent/schemas/tools.ts`), never duplicated into a harness catalog — `tests/main/unit/toolsSchema.test.ts` enforces this boundary (required sections, no per-tool catalog entries, no runtime-limit essays).
- Facts the runtime already enforces — concurrency, serial execution, approval gates — stay out; the harness points at the tool catalog and the mode section for the turn.
- Meta-assembly and run-time documentation (this handbook's topics) stays out of the harness too.

## Run-file contract

Each run persists under `{userData}/workspaces/{workspaceId}/sessions/{runId}/`:

| File | Contents |
|------|----------|
| `contract.md` | Run contract text (not Keep/Discard checkpointed) |
| `status.json` | Run status: step, status, mode, error |
| `messages.jsonl` | Canonical chat transcript — one JSON message per line; the UI rebuilds the timeline from it |
| `events.jsonl` | Append-only ops log (`status`, `step_usage`, `context_usage`, …) with ISO `at` timestamps |
| `receipt.json` | Structured run summary — the harness-review input (below) |
| `plan.md` | Plan-mode working plan (run artifact, not checkpointed) |
| `receipt.json` | Per-run receipt (status, tool stats, failures, contract excerpt) |

`receipt.json` (`RUN_RECEIPT_FILENAME`, written by `writeRunReceiptBestEffort` in `src/main/agent/runReceipt.ts`) captures: run status and step, token usage, compaction count, per-tool call/ok stats, failure clusters, unread-edit paths, written files, diagnostics call counts, and a contract excerpt. It is flushed at step 0, every 5 steps, and once more from a `finally` at run end — always best-effort, never throwing into the agent loop.

## Harness review/apply flow

The loop is a human review scaffold: receipts are mined into proposals, humans edit and confirm — not unsupervised Self-Harness.

1. **`/harness-review`** (slash builtin; `harnessReview` IPC → `runHarnessReviewWithSettings`) mines the most recent run receipts (default limit 20) into a weakness summary. Evidence buckets (`system_prompt`, `tool_policy`, `loop_notices`, `memory`) map each failure mode to the harness section that owns it, with the receipt evidence attached. An optional LLM pass (`harnessRewrite.ts`) can rewrite the proposed body.
2. The proposal is written to `.vyotiq/harness/proposals/<timestamp>-<id>.md` containing Evidence, Evidence buckets, Suggested harness edits, a `## Proposed harness body` fenced markdown block, and a Validation section.
3. **`/harness-apply`** (`harnessApply` IPC; `harnessPreviewApply` previews the diff first) applies the latest — or a named — proposal after explicit confirm. Apply writes only `resources/harness/default.md`, backs up the previous text to `.vyotiq/harness/default.md.bak`, then runs the fixed vitest gate (`HARNESS_EVAL_TESTS`, which includes the frozen held-out grader `harnessHeldOutEval.ts` — it never auto-applies). On gate failure the file is reverted from backup.
4. Evaluator code, gate tests, and held-out fixtures are outside the apply surface: changing them requires a normal PR, not harness-apply.
