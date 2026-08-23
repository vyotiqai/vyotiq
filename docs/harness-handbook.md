# Harness handbook

Maintainer reference for Agent V prompt ownership, assembly, and review.

## Ownership

- `resources/harness/default.md` is the canonical first-party harness. It contains durable, provider-independent behavior only.
- `src/main/agent/tools/modePolicy.ts` owns Ask, Plan, and Agent mode instructions and hard tool gates.
- `src/main/agent/schemas/tools.ts` owns tool names, arguments, limits, and usage details.
- `src/main/agent/loopPolicy.ts` owns transient retry, catalog, compaction, and failure notices.
- `src/main/agent/context/assemble.ts` owns ordering, budgets, and prompt-section placement.
- Provider adapters translate stable and volatile zones to each API; they do not define agent behavior.
- Internal LLM jobs such as compaction and harness rewriting use dedicated prompts.

Word documents are reference copies, not runtime policy sources. Build and install commands do not regenerate the canonical harness from `.docx`.

## Prompt assembly

Stable system order:

1. Canonical harness
2. Mode section
3. Run contract
4. Approved or in-progress plan
5. Available skill metadata
6. Plugin-rule metadata
7. User-global rules
8. Workspace rules
9. Prior compaction summary, labeled as earlier-session data

Per-step volatile context contains session environment, workspace snapshot, task list, and run notices. Providers send it after conversation history inside `<live_session>`.

`src/main/agent/harness.ts` always loads the bundled canonical harness, or its built-in security fallback if unavailable. A workspace `resources/harness/default.md` is validated, capped, escaped, and appended inside `<workspace_harness>` as untrusted preferences. It never replaces the first-party harness or overrides constraints, tool policy, or mode.

Memory files are not injected automatically. Agents access `.vyotiq/memory/` through memory tools.

## Editing rules

Keep the canonical harness short and imperative. Do not duplicate mode availability, tool schemas, provider transport, runtime thresholds, approval behavior, or assembly details. Every claimed capability must exist in the current tool registry and dispatcher.

Prompt tests should assert semantic contracts: valid sections, trust boundaries, registered capabilities, precedence, token budget, and consistency with runtime behavior. Avoid locking incidental wording.

## Run artifacts

Each run is stored under `{userData}/workspaces/{workspaceId}/sessions/{runId}/`:

- `contract.md`: run contract
- `plan.md`: Plan-mode working plan
- `status.json`: current run state
- `messages.jsonl`: canonical chat transcript
- `events.jsonl`: append-only operational events
- `receipt.json`: best-effort run summary used by harness review

## Harness review and apply

`/harness-review` mines recent receipts into evidence-backed suggestions. Findings must be routed to their owner: durable behavior to the harness, mode failures to mode policy, tool failures to tool schemas, and loop notices to loop policy.

Proposals are written under `resources/harness/proposals/`. `/harness-apply` previews the diff, requires explicit confirmation, writes only canonical `resources/harness/default.md`, and stores its backup at `resources/harness/default.md.bak`.

Apply runs the fixed `HARNESS_EVAL_TESTS` gate and restores the backup on failure. Evaluator code, gate tests, and held-out fixtures remain outside the apply surface and require a normal code change.
