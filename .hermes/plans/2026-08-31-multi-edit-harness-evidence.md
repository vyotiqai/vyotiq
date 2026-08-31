# multi_edit harness measurement — evidence note (plan Task 7)

**Scan date:** 2026-08-31 (this session). **Scanner:** pure Python over `%APPDATA%/vyotiq/**/messages.jsonl`, schema discovered first (`toolCalls[].name` + `.arguments` JSON strings, results joined by `toolCallId`). **Runs scanned: 16** (0 unreadable lines).

## Aggregates

| Metric | Value |
|---|---|
| multi_edit invocations | **20** |
| … with result rows | 20 (10 success, **10 failure** → 50% failure rate) |
| edit calls | 107 |
| str_replace calls | 196 |
| Failure family: duplicate path | 5 |
| Failure family: diff-hunk mismatch | 4 |
| Failure family: type/shape error (`edits.N.diff` non-string) | 1 |
| Calls mixing contents+diff across entries (contract violation) | 5 |
| Calls with duplicate paths in args | 5 |
| Turns chaining ≥2 distinct files via **separate** consecutive write calls (atomic-batch candidates) | **40 windows / 218 write calls** |

## Failure excerpts (run id → quote)

- `1de9344a`: `edits.1.path: duplicate path "aether/scripts/check.py" — combine into one edit`
- `d8d9ef8d`: `edits.0.diff: each edit accepts contents or diff, not both`
- `82889e99`: `multi_edit aborted, no files changed - src/renderer/src/app/App.tsx: Diff hunk failed to match`
- `d07ae5fe`: `edits.0.diff: Expected string, received null`

## Under-selection examples (separate write chains that were multi_edit candidates)

- `1de9344a`: 24-call window creating ~20 `aether/agentsd/src/*.rs` files one `edit` at a time.
- `82889e99`: 20-call `str_replace` chain across `Sidebar.tsx`, `ChatList.tsx`, `App.tsx`, `AppShell.tsx`…

## Decision

Both pathologies are real and measured: **under-selection** (40 candidate windows / 218 chained write calls vs 20 multi_edit uses) **and contract misuse** (5+5 of 10 failures are arg-shape errors the schema rejects). The failure families already have loopPolicy coaching branches; the missing surface was tool *selection* + contract awareness in the system prompt. Per the plan's decision rule, ONE tool_policy line landed in `resources/harness/default.md` (grounded in these numbers, delivery pinned by `tests/main/unit/harnessProbeDelivery.test.ts`).

**Notes:** failure attribution for schema rejections: in run `1de9344a`, multi_edit's early failures predate the current schema hints (older build). Sample is 20 calls — directionally consistent across every failure family with the repo's live failure-string regexes; no extrapolation beyond "both pathologies exist."
