# Agent V Runtime Audit — Streaming, Context Management, Injection, Persistence

Date: 2026-08-28 · Mode: Agent · Branch: `main` (working tree, uncommitted in-flight work preserved)

## Method

1. Inventoried `%APPDATA%\vyotiq` via approved **read-only** shell (`dir`/`copy` only; `secrets.json` and credential stores never opened).
2. Copied runtime evidence into workspace scratch `_audit-runtime/`: main log `vyotiq.log` (380 KB, 3,513 entries), 4 session run dirs (`events.jsonl` + archives + `messages.jsonl`, 2,098 telemetry events).
3. Forensic scans over all events/logs (type histogram, failure-pattern projections, multi-line entry extraction).
4. Deep-read of streaming (`loop.ts` stream driver 2030–2760, `streamRetry.ts`, `providers/sse.ts`, `providers/fetchWithRetry.ts`, `circuitBreaker.ts`), context (`assemble.ts`, `budget.ts` + `shared/domain/contextBudget.ts`, `compact.ts`, `compactRun.ts`, `toolTrim.ts`), injection (`untrustedContent.ts`, `promptSections.ts`, `harnessSections.ts`, all 5 wrap call sites), persistence (`messageAppendQueue.ts`, `eventAppendQueue.ts` + tests, `state.ts` readers).
5. Every issue below carries file:line evidence; runtime-corroborated items are marked **[runtime]**.

## Verified findings

### F1 — Leaked half-open circuit probe on un-retried attempt throw — **[code-verified] FIXED this run**

`streamRetry.ts` both drivers (`runWithStreamRetry`, `runWithStreamRetryGen`) released the half-open probe only when the rethrown error was an `AbortError`. Any other exception that escapes an attempt and is not retried (e.g. `flushPartialAssistant`/`emitTerminalRunError` throwing inside the loop's `runAttempt`, per `loop.ts:2496-2527`) leaves the probe slot consumed. Effect: `assertCircuitClosed` (`circuitBreaker.ts:81-101`) then throws `CircuitOpenError` for **every** later request on that provider/endpoint key until app restart — a hard provider outage from one bad throw.

- Fix: `src/main/agent/streamRetry.ts` — both `decision.action === 'throw'` paths now call `releaseCircuitProbe(options.circuitKey)` unconditionally (the attempt ended without a success/failure record either way; terminal/complete/exhausted paths were already correct).
- Tests: 2 new cases in `tests/main/unit/streamRetry.test.ts` (`releases the half-open probe…`, `runWithStreamRetryGen releases…`) reproduce the leak against the old code shape and pin the new contract. `circuitBreaker.test.ts` + `streamRetry.test.ts`: 26/26 pass.
- Runtime corroboration: none observed in the captured logs (all `CIRCUIT_OPEN` events were `mcp-connect:*` keys with their own threshold-1 policy). Classified as code-verified defect, not a runtime incident.

### F2 — events.jsonl rotation corrupted run telemetry — **[runtime] already fixed in working tree**

Runtime evidence (session `5848c636`, rotation at `2026-08-28T12:14:45`): the current `events.jsonl` line 1 is a mid-line fragment (`n: delete the loop.ts dead branches…` — the head of a JSON line missing) and 3 events (`11:19:08.230/.231`) appear in **both** the archive tail and the current file head.

- Root cause (HEAD `eventAppendQueue.ts`): the split point was computed as a JS **string** index (`headText.lastIndexOf('\n')` after `toString('utf8')`) but then used as a **byte** offset for `handle.read(..., splitAt)`. With multibyte (non-ASCII) content, every multibyte char shrinks the string index relative to the byte offset, so the tail re-read overlaps the last bytes of the head region — producing exactly the observed duplication + fragment. `runReceipt.ts`-style thinking bodies are full of non-ASCII, so long thinking sessions always trip it.
- Working tree already contains the correct byte-level implementation (`headBuf.lastIndexOf(0x0a)` on `Buffer`) plus boundary tests (`keeps the JSONL record that crosses the rotation byte boundary`, `keeps UTF-8 JSONL records valid across a rotation boundary` — both pass). `messages.jsonl` rotation is new in the working tree and was byte-level from the start (HEAD had none).
- Tolerance: readers parse line-by-line and skip invalid lines (`state.ts:480-485`, `state.ts:710-715`), so the already-corrupted on-disk boundary degrades to a skipped line, not a crash. No data-loss risk beyond the single duplicated/fragmented line already present.
- No new code change required. **Action for the user: ship/rebuild the app so the installed binary stops running the HEAD build** — the observed corruption came from the pre-fix build.

### F3 — Compaction run-death on retired model — **[runtime] behavior verified; copy gap logged, not fixed (product decision)**

Runtime evidence (`vyotiq.log` 2026-08-27 16:32:38): OpenRouter returned HTTP 404 with "This model was ZAI's GLM-5.3 Flash" (retired `stealth/ox-alpha`) → all three summarizer paths failed (`COMPACTION_FORK` → `COMPACTION_STREAM`) → `compactMessages` returned null → `CompactionUnavailableError('The model returned no summary.')` (`compactRun.ts:407`) → loop emitted terminal run error (`loop.ts:1824-1836`) → run died mid-step-44.

- Current tree already adds one flattened-tools retry (`summarizeWithTimeoutRetry`, `compactRun.ts:348-371`) which converts transient empty responses into recoverable events; two later auto-compactions succeeded (08-27 19:31, 08-28 17:09).
- Remaining gap: when the root cause is a permanent provider HTTP failure (dead model), the user-facing message is still "The model returned no summary." — the true cause (404 + provider message) is only in `vyotiq.log`. Threading the last provider failure into `CompactionUnavailableError` touches the `collectCompactionStreamText → compactMessages → compactRun` chain — a copy/UX product decision, logged here per the no-unilateral-product-changes gate. Reproduction: select a retired OpenRouter model and exceed the auto-compact trigger.

### F4 — Runtime failures correctly classified as tool-level, non-fatal — **[runtime] no action**

Across 2,098 events: all `tool_result ok:false` items (todo_write schema errors, multi_edit diff-mismatch aborts, `startLine past end of file`, cancelled reads, terminal non-zero exits) stayed tool-scoped; runs continued. `Circuit opened` warnings for `mcp-connect:github/gmail` recur at the by-design threshold-1/open-60s probe cycle — expected, not a defect. `Provider network failure` was one `CATALOG_PROBE` (Ollama down) with soft cooldown — by design.

### F5 — Injection surfaces verified intact — no finding

All five untrusted sources are wrapped with `wrapUntrustedContent` (nonce per wrap, attr-escaped origin/kind): workspace rules (`context/rules.ts:278`), workspace harness appendix (`harness.ts:163`), MCP resources/prompts/tool results (`mcp/index.ts:305`, used at `:1461`, `:1535`, `:1592`), skill bodies/files/plugin rules (`tools/skill.ts:39/86/122`), browser pages (`app/browserContentBoundary.ts:10`). Neutralization escapes structural open/close tag sequences case-insensitively (`promptSections.ts:20-26`, `untrustedContent.ts:17-23`); the workspace appendix cannot outrank the spine under `capHarness` (`assemble.ts:146-152` spine cap 49 for appendix sections). No runtime log line showed a wrap escape.

### F6 — Context budget/trigger math verified against runtime — no finding

`compactionTrigger = 490,208` for a 1,048,576 window matches `proactiveCompactThresholdTokens(891,288, 0.55)` (`contextBudget.ts:41-48`); auto-compaction fired at estimated 491,828 and 502,164 ≥ threshold. Budget shares (12/18/15/40/15, buffer remainder), the stable-prefix fingerprint (volatile fields excluded — `assemble.ts:71-97`), provider-metered `context_usage` (`loop.ts:2066-2076`), and `toolTrim` durable-tool protection were all consistent with observed events. The meter switches `source: estimate → provider` after the first step — by design.

## Verification (this run)

- `pnpm typecheck` → exit 0.
- `pnpm lint` → exit 0 (4 pre-existing warnings, 0 errors).
- Targeted: `streamRetry.test.ts` + `circuitBreaker.test.ts` → 26/26 pass; `eventAppendQueue.test.ts` rotation/boundary tests pass (pre-existing, re-confirmed via suite).
- Full suite `pnpm test`: see final gate line appended below.

## Evidence files (scratch, untracked)

`_audit-runtime/`: `vyotiq.log`, session dirs `1d7ca5-15beec`, `1d7ca5-5848c6` (+ events archive), `1d7ca5-f482b9`, `2c90e1-7abe54`, projection scripts `proj-*.ps1`, `full-test.log`.
