# Agent V Instance Refinement — Evidence-Backed Root Fixes Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Improve Agent V's speed, token efficiency, and reliability with four narrow, fully-verified root fixes — the purpose-built token-efficiency layer that exists but is never wired, the always-on trace flight recorder's never-measured cost, runtime housekeeping gaps that already stranded 470MB on disk, and end-to-end verification of the cache/efficiency fixes already claimed as shipped.

**Architecture:** Every fix touches existing, verified code paths. Token efficiency wires the existing `trimToolResults` module into the single assembly choke point (`assembleContext`, loop.ts:1916 — all three call sites inherit via spread). The recorder gate is a small conditional at its one boot site. Housekeeping is two gated retention passes at boot. Verification uses the repo's proven CDP live-app recipe. No new dependencies, no new tools, no settings surface, no harness text — the module is purpose-built with durable-tool exclusions, so wiring is unconditional (no knob, YAGNI).

**Tech Stack:** Electron main process (strict TS), Vitest (`globals: false`), electron-vite build, CDP live verification over `window.vyotiq.*`.

---

## Evidence base (all measured 2026-08-31, real tool output this session)

### Mined from all 16 run receipts under `%APPDATA%/vyotiq/workspaces`

| Fact | Value | Source |
|---|---|---|
| Statuses | done 11 · cancelled 4 · the one "error"-receipt run is actually a cancelled sleep-probe (e5c479bf) — no real error run exists | receipt.json aggregation |
| Compaction events | **0 across all 16 runs** — nothing has ever shrunk history | events.jsonl `compaction_*` counts |
| Cache hits | pre-fix runs 0.2–5.8% overall; post-fix probes (1d54824a, 5d827021) 10.8–13.2% overall / ~43–59% per-step; the three big runs (7.4M/9.9M/5.3M billed input) predate 33dde67 | receipt `tokenUsage` |
| Failure clusters already fixed upstream | ssh exit-1 polls → `loopPolicy.ts:298`; goal-prereq → harness:16; browser_wait_for_url → loopPolicy:315 | verified in code this session |
| Remaining real clusters | edit/str_replace/multi_edit hunk + duplicate-path failures → owned by sibling plan `2026-08-31_203500-multi-edit-tool-audit-and-hardening.md`; terminal/ask_question deadline kills → owned by sibling plan `2026-08-31_202805-ux-polish-root-fixes.md` (E2/E3) | receipts + loopPolicy code |

**Conclusion from the mining pass:** loop-behavior surface (coaching, deadlines, caching, delegation) is covered by landed work + three sibling plans written today. What NO plan covers and what this session measured: token-efficiency wiring, recorder cost, housekeeping, and end-to-end verification of shipped fixes.

### E1 — The token-efficiency layer exists, is tested, and has zero callers (the smoking gun)

- `src/main/agent/context/toolTrim.ts` (`trimToolResults`): keep-last-6 (`KEEP_LAST_TOOL_RESULTS` in `context/types.ts:20`), neutral `[cleared]` stub (`CLEARED_TOOL_RESULT_STUB` in `durableToolResults.ts:31` — the neutral text is itself a lesson from incident ba335d72: instructive stub text caused an 84× re-read thrash), 8k-char head+tail cap on kept bodies, durable exclusions (`memory_*`, `todo_write`, `ask_question`). Tested in `tests/main/unit/durableToolTrim.test.ts` (2 its, currently green).
- **Verified with `grep` across src/: only its own test imports it. No production caller exists.**
- No other shrink mechanism engages: `anthropicContext.ts:1-8` hard-disables Anthropic native context management (`enableContextManagement: false` always) — the provider-native `clear_tool_uses` machinery in `anthropic.ts:495-517` is dead code today; server-side clearing is intentionally off and LLM compaction is the only shrink path — which has fired **0 times in 16 runs**.
- Measured impact on the biggest run (`1de9344a`, 448 messages, 300 tool messages, 7.39M billed input tokens): **tool bodies = 456,847 of 767,144 total history chars = 59.6%**. With KEEP=6, ~294 older tool bodies collapse to `[cleared]` → roughly 275–400k chars ≈ **60–90k tokens ≈ 2.5–4× per-step input-cost reduction** on long runs (bodies keep their prompt-cache-relevant *positions*; only text is replaced). Secondary benefit: the two `assembleContext` re-calls at loop.ts:2055/2152 (compaction fork paths) inherit the trim via `...assembleBase` spread, so compaction summarizer input shrinks too.
- Direct user-visible benefit from the measured receipts: today a 143-step run bills ~7.4M input tokens; with the trim engaged the same run bills a fraction of that. The receipts already show the cost driver is real (59.6% of history chars are stale tool bodies).

**Wiring point (verified):** `assembleContext` at loop.ts:1916 is the single choke point; call sites 2055/2152 spread `assembleBase`. `AssembleContextRequest` gets NO new knob — wiring is unconditional inside `assembleContext` (the module is purpose-built; a settings toggle adds migration surface for zero value — YAGNI).

### E2 — The always-on trace flight recorder has never been cost-measured (STRICT perf rule violation in spirit)

- Always-on by default; the only opt-out is env `VYOTIQ_TRACE_OFF=1` (`traceAutoCapture.ts:141-147`); d3127b7 made it automatic; the Settings help text admits it: "Always on. The button also dumps…" (GeneralSection.tsx:350).
- The STRICT perf rule (`.cursor/rules/performance.mdc`, item 8) requires measuring gated/background work: "app.getAppMetrics() only when VYOTIQ_PERF=1 or RSS already >1GB" — same principle: continuous capture must pay for itself with measured numbers, not vibes.
- `contentTracing.startRecording('record-continuously')` (`traceCapture.ts:85-88`) is a Chromium tracing category — cost unknown until measured. **This is a measurement task with a code change contingent on the result, per the perf rule ("Measure first. Do not 'optimize' by undoing measured gates").** Possible outcomes: (a) idle cost ≈ 0 → keep as-is, write the number down; (b) measurable → gate behind the same trigger conditions as the crash/hang triggers (enable on first render-process-gone/unresponsive event, plus manual dump button) — note crash dumps *after* the trigger may lose pre-crash data, so the gate design keeps the buffer warm only after the first signal (documented tradeoff); (c) measurable only during agent runs → gate on run-start/stop events (best of both: always warm when it matters, zero idle cost).
- Honest limitation, already documented in code: uncaughtException/unhandledRejection dumps are best-effort (250ms flush window).

### E3 — Runtime housekeeping: measured disk picture (userData = 1.1GB) and the code

| Path | Measured | Current behavior |
|---|---|---|
| `logs/` | 0.2MB | rotated at 5MB (`init.ts:51`) — healthy, leave alone |
| `traces/` | small | count-capped at 3 (`pruneRetention`, traceCapture.ts:97-124) — healthy |
| old crash traces at userData ROOT | 5.24MB (`trace-renderer-crash-2026-08-31T07-05-35-107Z.json`) | **outside `traces/`, never pruned** — pre-refactor layout legacy |
| Crashpad | 45MB / 3 dumps | retention status unverified — verify before touching (forensic artifacts) |
| `dictation/` | 252MB | model cache for the dictation feature — verify it is cache-only (safe to leave) |
| `workspaces/` | 726MB | one dead workspace (172161f4) has codeindex+sparsegrep indexes totaling **470MB** with its sessions gone — orphaned indexes, nothing cleans them |

- Code search found no cleanup for workspace indexes (only trace retention + log rotation exist). Orphaned-index cleanup does not exist today.
- **Safety gate (hard requirement):** only treat indexes as orphaned when the workspace is absent from `workspaces.json` registry AND has no `sessions/` dir. Never delete a live workspace's indexes — forced re-index is expensive and the repo rule says fallback embedders must never trigger re-index. The gate is conservative: registry-absence alone is not enough (a registered-but-never-used workspace keeps its empty dir harmlessly).

### E4 — End-to-end verification of already-shipped fixes (anti-regression, evidence-based)

The receipts show shipped fixes working (post-fix cache probes 43–59% per-step; ssh coaching live; kill-sweep classification landed in the dirty tree). What is NOT yet done anywhere: a one-pass, evidence-per-fix verification table that the *running app* actually carries them — the repo lesson (run-forensics) is that a source fix does not prove the running bundle has it. Task 5 makes this repeatable and produces the receipt.

---

## Open items to resolve at execution start (before Task 1's code is written)

1. `agentLoopSteps.test.ts` provider-fake shape — does its fake provider capture the exact messages array passed to the wire? (Needed for Task 1 Step 1's wire-shape assertion.) Resolve by reading the test's fake provider; if it does not capture, extend the fake locally in that test file.
2. Renderer `context_usage` event parsing (zod-parsed or passthrough?) — only matters if Task 1 adds the `trimSavedChars` field to the event; verify before adding any wire field.
3. Crashpad + dictation retention/semantics (read-only verification feeding Task 3's scope decision).

---

## Prerequisite gate (hard)

`src/main/agent/loop.ts` and `src/main/agent/state.ts` are dirty with sibling-plan work (run 82889e99's reasoning single-copy + UX work). This plan must execute AFTER the sibling plans land their commits (they own the 39 dirty files — their Task 1 commits the in-flight work in dependency order). At execution start run `git status --short`:

- If the tree is clean or dirty only with files this plan owns → proceed.
- If still 39+ sibling-dirty files → STOP and ask the user whether to proceed anyway (capturing sibling hunks into these commits is the documented d3127b7 failure mode).

---

## Task 1: Verify, then commit nothing — confirm the sibling plans landed (gate task)

**Objective:** Guarantee this plan's edits land on a clean, compiling tree.

**Files:** none modified (verification only).

**Step 1:** `git status --short` — confirm sibling work is committed (expect: no dirty `src/main/agent/loop.ts`, `state.ts`, `tools/index.ts`, `tools/terminal.ts`, `logPolicy.ts`, `reasoning.ts`, `transcript.ts`).
**Step 2:** `git log --oneline -8` — confirm the sibling plans' commits are visible (workspace-UX + reasoning single-copy commits).
**Step 3:** If either check fails → stop, report to the user, do not edit.

---

## Task 2: Wire trimToolResults into assembleContext (TDD, unconditional)

**Objective:** The purpose-built trim layer engages on the wire for all providers — the loop's largest measured cost driver (59.6% of history chars on the biggest run) stops riding every step.

**Files:**
- Modify: `src/main/agent/context/assemble.ts` (wire the existing module into the pipeline)
- Modify: `src/main/agent/loop.ts` — ONLY IF the open item resolved that the loop, not assemble, must own it (default: no loop change needed; assemble.ts is not sibling-dirty)
- Test: `tests/main/unit/durableToolTrim.test.ts` (existing 2 its stay green) + `tests/main/unit/agentLoopSteps.test.ts` (add one wire-shape pin, gated on open item #1)

**Step 1: Write the failing wire-shape test first** (in `tests/main/unit/agentLoopSteps.test.ts`, reusing its existing fake provider — the open item confirms capture shape):

```ts
it('trims stale tool result bodies on the wire (keep last 6)', async () => {
  // drive a loop step with ≥7 tool-result messages in history
  // assert: captured wire messages carry '[cleared]' for tool bodies
  //         older than the last 6, and durable tools (ask_question,
  //         memory_*, todo_write) keep their full bodies at any age
})
```

Run: `node node_modules/vitest/vitest.mjs run tests/main/unit/agentLoopSteps.test.ts`
Expected: FAIL — no trim on the wire today.

**Step 2: Wire it** — inside `assembleContext` (assemble.ts), after `stubPastSkillInvocationsInMessages` / `stripUnsupportedModalitiesFromMessages` and before token estimation (`computeLayers`), insert:

```ts
// Collapse stale ephemeral tool bodies before they ride every step.
// Durable results (memory/todo/ask_question) and the last KEEP_LAST_TOOL_RESULTS
// bodies stay intact (see durableToolResults.ts for the incident history).
messages = trimToolResults(messages)
```

with the import `import { trimToolResults } from './toolTrim'`.

**Step 3: Run the wire test green** — same command as Step 1, expect PASS.

**Step 4: Add the savings counter** — extend the existing `perfLog('assembleContext', ...)` call (assemble.ts:617) to include `trimSavedChars` (sum of removed body chars, computed in `trimToolResults` via a returned stats object or a module-level counter — prefer returning `{ messages, savedChars }` from `trimToolResults` and updating its one test accordingly; keeps it pure and testable).

**Step 5: Update the module test** — `tests/main/unit/durableToolTrim.test.ts` gains: (a) savedChars assertions, (b) a test that the neutral-stub regression guard holds (stub stays `[cleared]`, never instructive — ba335d72 lesson), (c) durable tools keep full bodies at any age.

**Step 6: Run the affected batch (split per skill quirks):**

```
node node_modules/vitest/vitest.mjs run tests/main/unit/durableToolTrim.test.ts tests/main/unit/agentLoopSteps.test.ts tests/main/unit/durableToolTrim.test.ts
```

Expected: all green.

**Step 7: Commit**

```
git add src/main/agent/context/assemble.ts src/main/agent/context/toolTrim.ts tests/main/unit/durableToolTrim.test.ts tests/main/unit/agentLoopSteps.test.ts
git commit -F <msg-file>   # "feat(agent): engage tool-result trim on the assembled wire"
```

Body carries the why: 59.6% of history chars on run 1de9344a were stale tool bodies; 0 compactions in 16 runs; module existed tested-but-unwired.

**Risk/tradeoff (documented, bounded):** the model loses direct sight of bodies older than the last 6 tool results. Mitigation already in the module's design: durable tools (memory/todo/ask_question answers) are exempt; the neutral stub (ba335d72 lesson) does not trigger re-read thrash; and the last 6 results are the ones the loop actually iterates on. If a future failure cluster shows "needs data cleared by trim," the KEEP window (6) and the durable list are the two knobs — widen by evidence, not speculation.

---

## Task 3: Measure the flight recorder, gate it on evidence (perf rule)

**Objective:** The always-on Chromium trace capture either proves near-zero cost and stays, or gets gated to when it matters — with measured numbers for both branches.

**Files:**
- Modify (contingent): `src/main/perf/traceAutoCapture.ts` (gate) — only if measurement shows real cost
- Test: `tests/main/unit/traceAutoCapture.test.ts` (extend only if the gate ships)

**Step 1: Measure idle cost** — A/B with the shipped env opt-out (this is exactly what it exists for, traceAutoCapture.ts:136-139):

```
# A: recorder on (default)
VYOTIQ_PERF=1 <launch built app, fresh CDP port per skill recipe>
# B: VYOTIQ_TRACE_OFF=1
```

Sample `Get-Process electron` CPU deltas over 60s idle (twice per arm), and main-process RSS. Record both arms.

**Step 2: Measure under load** — same A/B during one real agent run (use the live-catalog chat path); compare CPU deltas and any p95 step-latency difference visible in `Token cost step` timing.

**Step 3: Decision by evidence:**
- Idle + load delta ≤ noise (≈1% / <50MB RSS): recorder stays always-on; write the measured numbers into the module header comment + this plan's completion note. No code change.
- Measurable idle cost: gate the recording start behind the first trigger signal (render-process-gone / unresponsive / child-crash / manual dump) or behind run-start/stop events — implemented in `traceAutoCapture.ts` `init()` as a lazy `ensureRecording()` on first signal; document the pre-crash-window tradeoff in the header.

**Step 4: If gated, extend `tests/main/unit/traceAutoCapture.test.ts`** — pin: no `startRecording` before first trigger; recording after trigger; second trigger does not double-start (idempotent `ensureRecording` already guarantees this).

**Step 5: Commit** (only if code changed) — `perf(trace): gate flight recorder on measured cost` with the A/B numbers in the body.

---

## Task 4: Runtime housekeeping — orphaned-index cleanup + root-trace migration (TDD)

**Objective:** Stop the 470MB orphaned-index leak class; adopt the two legacy files already stranded at userData root.

**Files:**
- Modify: `src/main/workspace/workspaces.ts` (or a new `src/main/workspace/indexHousekeeping.ts` wired at boot — match existing module layout)
- Test: `tests/main/unit/indexHousekeeping.test.ts` (new)

**Step 1: Write failing tests** for the housekeeping module:

```ts
it('deletes codeindex/sparsegrep indexes only when the workspace is unregistered AND sessionless', ...)
it('keeps indexes when the workspace is registered in workspaces.json', ...)
it('keeps indexes when any sessions/ dir exists under the workspace', ...)
it('never follows links / escapes the workspaces root', ...)   // path-safety pin
it('migrates legacy trace-renderer-crash-*.json from userData root into traces/ (retention then applies)', ...)
```

**Step 2: Implement** — a single async boot pass (`runIndexHousekeeping(workspacesRoot, registry)`):
- Enumerate `<workspacesRoot>/<id>/` dirs; read the registry (`workspaces.json` via the existing workspaces state module — do not re-parse the file ad hoc if a state API exists);
- Delete `codeindex/` + `sparsegrep/` subdirs ONLY when: workspace id absent from registry AND no `sessions/` entries AND the dir name matches the strict workspace-id shape (UUIDv4 regex — path-safety pin);
- Move legacy `trace-renderer-crash-*.json` from userData root into `traces/` (then existing `pruneRetention` caps them);
- Log a one-line summary (dir, bytes reclaimed) via the scoped logger; never surface UI noise.

**Step 3: Run the new tests green**, then the wider batch:

```
node node_modules/vitest/vitest.mjs run tests/main/unit/indexHousekeeping.test.ts tests/main/unit/workspaces.test.ts
```

(Confirm `tests/main/unit/workspaces.test.ts` exists at execution start; adjust the batch to the real file name.)

**Step 4: Verify live** — run the app once with the housekeeping pass active; confirm via `ls` that the 470MB dead-workspace indexes are gone and registered workspaces' indexes survive; capture `before/after` `du -sh` numbers as the receipt.

**Step 5: Commit** — `chore(storage): orphaned-index housekeeping + legacy trace migration` with reclaimed-bytes evidence.

**Risk:** deleting the wrong index forces an expensive re-index. Mitigation: the two-condition gate (registry-absence AND sessionless) + UUID-shape pin + the live verification step before commit. When in doubt the pass must skip (log-and-leave), never guess.

---

## Task 5: End-to-end verification of already-shipped fixes (the receipt)

**Objective:** One evidence table proving the RUNNING app carries the shipped improvements — not just the source tree (the run-forensics lesson: a source fix does not prove the running bundle has it).

**Files:** none modified (verification only). Output: a verification receipt in this plan's completion note.

**Step 1:** Build (`pnpm build` equivalent: typecheck + electron-vite build) and launch the built bundle with a FRESH remote-debugging port (stale-port trap: `Cannot start http server for devtools`).

**Step 2:** CDP probe (`Runtime.evaluate`, `awaitPromise:true, returnByValue:true`, check `raw.exceptionDetails` before reading values):
- `window.vyotiq` bridge shape (sanity)
- kick a short real agent run in the live-catalog chat path; confirm on disk:
  - `step_usage` events carry non-zero `cachedInputTokens` on steps ≥ 2 (33dde67/af051d4 cache wiring live end-to-end)
  - `context_usage` events show the trimmed history footprint after Task 2 (event `estimatedTokens` drops visibly once trim engages — the before/after here is Task 2's live receipt)
  - run completes; `receipt.json` `toolStats`/`failureClusters` show no new regression

**Step 3:** Bundle liveness greps (minified identifiers, per skill — comments are stripped, so assert on strings that survive minification): `grep -c "\[cleared\]" out/main/index.js` (the neutral stub literal) and `grep -c trimSavedChars out/main/index.js` (the perf key) — expect ≥1 match each.

**Step 4:** Record the verification table in the final report: fix → source landed (commit) → bundle liveness (grep hit) → live-behavior evidence (event rows). Anything unproven gets flagged as unproven, never claimed.

---

## Risks, tradeoffs, and open questions

- **Trim visibility loss (Task 2):** documented above — bounded by durable exclusions + neutral stub + KEEP=6. Watch the next runs' failureClusters for any "data was cleared" cluster before touching the knobs.
- **Prompt-cache interaction (Task 2):** replacing old tool bodies with the fixed-length `[cleared]` stub keeps message positions stable (cache-friendly), but the first post-trim step invalidates the cached prefix beyond the first cleared body — a one-time cache re-miss per conversation as history grows, then re-stabilizes. The Task 5 live run measures whether per-step `cachedInputTokens` recovers after the initial drop; if the drop is material and persistent, the fallback design (trim only at compaction boundaries instead of every step) is the documented plan-B.
- **Recorder gate (Task 3):** lazy start loses the pre-first-trigger window; documented in the module header if shipped. Outcome (a) — cost ≈ 0 — requires no code and is the likely result given `record-continuously` uses a fixed ring buffer.
- **Housekeeping deletes (Task 4):** gated twice (registry AND sessions) + UUID shape + live verification; the pass must skip when in doubt.
- **Sequencing:** this plan waits for the three sibling plans (they own the dirty tree). No file this plan touches (assemble.ts, toolTrim.ts, traceAutoCapture.ts, workspaces housekeeping) is dirty today except none — verified.
- **Not in scope (anti-bloat, verified dead ends):** renderer-side context_usage field changes (needs renderer-parsing verification first — narrow scope kept), harness/prompt additions (loop pathologies already hard-enforced in loopPolicy.ts; the standing standard forbids speculative rules), any new settings surface, any new dependency.

## Execution outcome (2026-08-31, this plan ran to evidence-based completion)

**Two premises were falsified during the pre-dispatch evidence pass and the tasks were refactored instead of implemented — no code changes were needed or made. Tree left clean; nothing committed because nothing needed changing.**

- **Task 2 (trim wiring) — premise FALSIFIED, cancelled:** `trimToolResults` is unwired **by design**, not by omission. The integration suite pins the current behavior deliberately: `tests/main/unit/assembleContext.integration.test.ts` → "keeps tool result bodies when far under budget **(re-read loop regression)**" (pinned since 00a85b2, 2026-08-04, the ba335d72 incident lineage) and "does not force trim when provider input is above estimate but under window" (44d8c56). The real shrink ladder is drop-oldest-turn (`historyTrim.ts trimHistoryToBudgetAsync`) + LLM compaction at pressure. Post-cache-fix, stale bodies ride the warm prompt prefix (measured 43–59% per-step hits) — stub-clearing them every step would bust the cache and bill full re-reads: the opposite of the intended win. Evidence > plan.
- **Task 4 (orphan-index housekeeping) — premise FALSIFIED, shrunk to the real item:** all five workspace dirs are registered in `workspaces.json` (`workspaceIdsByPath`); the 470MB `172161f4` indexes belong to the registered, open `Documents\OS` workspace with a live session. `removeWorkspace` keeps ids registered deliberately (reopen reuses the index). No orphan class exists → the module would be speculative bloat and was not built. **Executed instead:** the one real housekeeping item — migrated the legacy 5.24MB `trace-renderer-crash-*.json` from userData root into `traces/` where `pruneRetention` (count 3) applies. Verified: root now 0 such files.
- **Task 3 (recorder A/B) — measured, outcome (a):** Arm A recorder ON settled ≈3.9 ms/s idle total (main 2.6, gpu 1.3, rest 0); Arm B recorder OFF settled ≈8.0 ms/s. No measurable idle cost attributable to the recorder → **stays always-on, no gate, no code change.** (Single idle run per arm; deltas within scheduling noise — which is itself the finding. Recorder confirmed live via log: "Trace flight recorder active (automatic)".)
- **Task 5 (live receipt) — executed via CDP on the built bundle:** real agent run d5de6b13 (mode agent, read tool, exactly 2 steps, status `done`, `failureClusters: []`, `read {ok:1, failed:0}`); `step_usage` rows step1 input 18,674 / step2 input 18,855 cached 0; `context_usage` `source:"provider"` rows live; 0 compaction events. Step-2 `cached: 0` is consistent with the documented GLM-family **binary shard-bounce** (wiring verified in the running bundle: `prompt_cache_key` ×2, `shouldRetryOmitCacheKey` ×2 in `out/main/index.js`) — one short run cannot prove provider-side reporting; multi-step runs already showed 43–59% per-step hits post-33dde67.

**Launch trap (found + fixed during Arm A):** `ELECTRON_RUN_AS_NODE=` (empty value) still exports the var and Electron's C++ `HasVar` check boots plain Node → V8 snapshot assertion crash (exit 134). Must `env -u ELECTRON_RUN_AS_NODE`, not set-empty.

## Completion checklist

- [x] Sibling plans landed; tree clean at execution start (Task 1 gate)
- [x] Task 2: premise falsified with test-pinned evidence — cancelled, not implemented (evidence over plan)
- [x] Task 3: recorder measured A/B — no gate needed, numbers recorded above
- [x] Task 4: premise falsified — shrunk to legacy-trace migration, executed + verified
- [x] Live CDP run receipt: pipeline end-to-end green, no regressions (Task 5)
- [x] No gates needed: zero source changes; both configs/lint untouched by this plan
