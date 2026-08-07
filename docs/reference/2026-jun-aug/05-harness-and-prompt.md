# Harness and system prompt assembly

The **harness** is behavioral policy for the agent system prompt — not a browser
automation harness.

## Runtime harness (`resources/harness/default.md`)

Loaded per invoke by `loadHarness` (`src/main/agent/harness.ts`):

1. Workspace copy `{workspace}/resources/harness/default.md` when present and well-formed
2. Else bundled `resources/harness/default.md`
3. Else one-liner fallback

Applied edits take effect on the **next invoke / new run**, never mid-step.

### Harness content themes

| Section | Policy |
|---------|--------|
| Role | Agent V — surgical, evidence-based changes |
| Capabilities | Built-in tools + MCP; mode governs availability |
| Visuals | Code-native SVG/HTML first; `generate_image` for photoreal only |
| Motion | CSS/WAAPI; honor `prefers-reduced-motion`; no `generate_video` |
| Tool policy | MCP pin/release; mode gates; Skill tool for marketplace skills |
| Constraints | Workspace sandbox; loop safety 8 failed / 6 repeat steps |
| Work style | Read-before-edit; checkpointed writes |
| Memory | `.vyotiq/memory/` markdown files |
| Output | Markdown; code citations |

Per-tool how-to lives in `src/main/agent/schemas/tools.ts` — **not** duplicated in harness.
`tests/main/unit/toolsSchema.test.ts` enforces this boundary.

## System prompt assembly (`assemble.ts`)

Per invoke order:

1. **Harness** — stable behavioral policy
2. **Stable prefix** — harness + workspace rules + skills/plugin Level-1 metadata + run contract + plan
   - Fingerprinted (`stableSystemFingerprint`) for provider prompt caching
   - OpenAI GPT-5.6+ and Anthropic send cache breakpoints (`systemZones.ts`)
3. **Mode section** — `modeSectionMarkdown` (`modePolicy.ts`) — Ask/Plan/Agent overlay
4. **Volatile suffix** — clock, workspace snapshot, memory index/state, loop hints, compaction summary

## Run-file contract

Per run under `{userData}/workspaces/{workspaceId}/sessions/{runId}/`:

| File | Contents |
|------|----------|
| `contract.md` | Run contract (not checkpointed) |
| `status.json` | Run status: step, status, mode, error |
| `messages.jsonl` | Canonical transcript |
| `events.jsonl` | Append-only ops log |
| `receipt.json` | Structured run summary |
| `plan.md` | Plan-mode working plan (not checkpointed) |

`receipt.json` flushed at step 0, every 5 steps, and in `finally` at run end — best-effort.

## Harness review/apply flow

Human review scaffold — not unsupervised Self-Harness.

1. `/harness-review` → mines recent receipts into weakness summary → proposal in `.vyotiq/harness/proposals/`
2. `/harness-apply` → applies proposal to `resources/harness/default.md` after confirm
3. On apply: backup to `.vyotiq/harness/default.md.bak`, run vitest gate (`HARNESS_EVAL_TESTS`)
4. Gate failure reverts from backup

Evaluator code and held-out fixtures are **outside** the apply surface (normal PR).

## Evidence

- `resources/harness/default.md`
- `docs/harness-handbook.md`
- `src/main/agent/harness.ts`, `harnessApply.ts`, `harnessReview.ts`, `harnessRewrite.ts`
- `src/main/agent/context/assemble.ts`
- `src/main/agent/tools/modePolicy.ts`
- `tests/main/unit/harness.test.ts`, `harnessApply.test.ts`, `harnessHeldOutEval.test.ts`
- `tests/main/unit/toolsSchema.test.ts`
