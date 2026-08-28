# Agent V Full Audit — Evidence-Based Findings

**Date:** 2026-08-27 · **Tree:** `main` @ 58d9373 (ahead 4 of origin/main) · 181 modified + 30 untracked files uncommitted
**Method:** every claim below cites a file/line, command output, or test run performed in this session. No assumptions.

---

## 1. What was verified to exist and work (positive findings)

| Area | Evidence |
|---|---|
| Tool registry ↔ handler parity | Programmatic extraction: **61 registry keys, 61 handlers, zero diff** (`src/main/agent/schemas/tools.ts:988-1280`, `tools/index.ts:470+`). Also enforced by `tests/main/unit/toolsSchema.test.ts` (41 tests ✓). |
| Docs parity | All 61 tools documented 1:1 in `landing/src/content/docs/reference/tools.md` (programmatic diff: empty). |
| Agent pipeline | `loop.ts` (3,383 lines) has: stream retry (5 attempts, `streamRetry.ts:15`), circuit breaker, network-monitor offline waits, loop-stop policies (`loopPolicy.ts:10-29`: identical-step streak 3, consecutive-failure 4, truncation 8, empty-response 4), MCP fail-fast, compaction, follow-ups, checkpoints, receipts. |
| Provider hosts | 11 wired in `providers/index.ts:34-44` (openai, anthropic, gemini, ollama, deepseek, groq, openrouter, xai, mistral, opencode + custom). |
| Security posture | `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` (`app/window.ts:96-99`); CSP builder (`app/security.ts:95+`); window-open → `shell.openExternal` + deny; nav/redirect guards; permission allowlist (`media` audio-only, `clipboard-sanitized-write`); cert-verify never bypassed (`security.ts:68-81`); sender validation on IPC (`ipc/register.ts:452-460`); secrets via `safeStorage` with scrubbing on Sentry (`logging/sentry.ts:39-43`). |
| Browser tool hardening | SSRF guard via `assertAllowedUrl` + per-hop redirect validation; per-workspace partition + download guard (≤100 MB, sanitized names, `.vyotiq/downloads`); domain allowlist (`agentBrowser.ts:87-108`). |
| Terminal/diagnostics sandbox | `parseSafeCommand` rejects shell metacharacters, no shell spawn; workspace-contained binary resolution (`tools/diagnostics.ts:90-164`); sanitized env; timeout + tree-kill. |
| Prompt-injection defense | `untrustedContent.ts` wraps browser/MCP/workspace-harness content in structural tags; harness `<constraints>` explicitly treat retrieved content as data (`resources/harness/default.md:23`). |
| Eval/verification | Held-out grader frozen with pinned cases (`harnessHeldOutEval.ts`, 7 cases); endurance/large-repo audit tests pass. |
| Full verification run (this session) | `tsc` node+web: **OK**. `vitest run` full suite: **all ~460 files / ~4,238 tests pass** (log reviewed; every file ✓). Lint not re-run this session (CI runs it). |

## 2. What it truly lacks / is missing (evidence-backed gaps)

### A. Resource limits were stripped to infinity — real regressions
Commit `a067d81` (2026-08-21, "Commit all working-tree changes") **removed hard caps**, confirmed by git log -L:

| Limit | Before | Now | Risk |
|---|---|---|---|
| `TERMINAL_MAX_OUTPUT` (`tools/terminal.ts:46`) | 64 KB + stream stop | `Number.POSITIVE_INFINITY`; `stdout += text` unbounded (`terminal.ts:781-787`) | A `cat` of a huge file or runaway build can OOM the main process; also inflates the 8K-char context trim only *after* full capture |
| `WEB_FETCH_MAX_BYTES` (`tools/webFetch.ts:23`) | 2 MB | `Number.POSITIVE_INFINITY` | Unbounded download into memory; hostile/large page → OOM |
| `MAX_BROWSER_TABS` (`app/agentBrowser.ts:38`) | 16 | `Number.POSITIVE_INFINITY` | Unbounded `WebContentsView`s → memory/fd exhaustion |

Mitigation exists only downstream (`context/toolTrim.ts:9` caps tool *bodies* at 8K chars **for the prompt** — the capture layer is unbounded). This contradicts the repo's own STRICT performance rule (`.cursor/rules/performance.mdc`: "never regress… idle RAM").

### B. Process reliability
1. **Vitest hang at suite end (root-cause evidence gathered 2026-08-27):** the full run prints the green summary, then the parent process stays alive indefinitely. Evidence: an orphaned `tinypool` fork worker (`node_modules/.pnpm/tinypool@1.1.1/dist/entry/process.js`) outlives its parent after a kill — the fork pool keeps an idle worker alive and a leaked handle inside one suite worker (suspects: node-pty conpty agent fork, MCP stdio session) prevents exit. Targeted clusters (pty + terminal + MCP + git e2e, 79 tests) exit cleanly in ~19s; the hang reproduces only on the full ~460-file suite. Vitest's built-in `teardownTimeout` force-exit (`process.exit()` after 10s) does NOT fire here — consistent with `process.exit()` itself stalling while a forked IPC channel is open on Windows. Killing the tree by PID (`taskkill /T /F`) works. **Mitigation shipped:** `scripts/test-exit-wrapper.cjs` (wired into `pnpm test`) runs vitest, waits `TEST_EXIT_GRACE_MS` (default 30s) after the summary prints, then force-kills the tree and maps the real pass/fail result onto the exit code. CI is unaffected (runner tears down at job end) but now also deterministically exits. A permanent fix remains per-suite teardown hygiene (dispose MCP clients / pty sessions in `afterEach`).

### C. Delivery/ops gaps
1. **209 uncommitted files on `main` (ahead 4)** spanning 5,391 insertions — goal system, loop scheduler, docx text tool, 30 untracked files. Any machine failure loses verified work; CI has never seen this tree (the last CI-verified commit is origin/main's).
2. **CI pins `pnpm@11.22.0`** (`.github/workflows/ci.yml` step "Enable pnpm") while `package.json` pins `pnpm@11.24.0` via `packageManager` — lockfile drift risk between local and CI.
3. **Release macOS signing is best-effort:** `release.yml` gates notarization on secrets existing; branch `fix/macos-unsigned-pack` exists specifically because DMG packing fails without a cert — Windows/Linux publish unsigned artifacts (no signing config at all in `electron-builder.yml` beyond macOS env plumbing).

### D. Product gaps (verified absent, not necessarily bugs)
1. **No i18n:** zero `i18next`/`react-intl`/`formatMessage` in `src/renderer` (grep: empty). English-only UI.
2. **No $ cost attribution:** `shared/utils/tokenCost.ts` is token-*attribution* (layers, cache-hit rates) — no pricing tables / USD estimates anywhere (grep `costUsd|pricing`: empty). ContextMeter shows tokens only.
3. **RAG scope:** README's "No embedding RAG" is accurate — `codeindex` embeds are local bag/ORT/Ollama-optional only; no external vector DB. (Design choice, listed for completeness.)
4. **Seeded model catalogs are placeholders** — acknowledged in README:66 and covered by `seedModelsPlaceholder.test.ts`; live catalog required for real model lists (offline-first users see illustrative IDs).

## 3. Historical note (fixed during this working tree, confirmed by the fresh full-suite run)
The stale 16:52 log (`%TEMP%/vyotiq-vitest-full.log`) showed 20 failures: real `ReferenceError: conflictedPaths/writeConflictedPaths is not defined` in `ChangeSummary.tsx`/`ChatView.tsx`/`ChangesPanel.tsx`, `toolWebFetch is not a function`, stale "1/10 saved" provider-count test, docs missing `opencode`. All now pass in the current tree (verified file-by-file in the new run). Nothing to do — recorded so the prior state isn't forgotten.

## 4. Verification commands used
- `git status/log/log -L`, parity extraction (python), CI/workflow reads
- `./node_modules/.bin/tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.web.json --noEmit` → OK
- `./node_modules/.bin/vitest run` (full, ~65 min local) → all pass, then hang (finding B1)

## 5. Addendum: run telemetry reconciliation (2026-08-27, user-provided app telemetry)

Source: `%APPDATA%/vyotiq/workspaces/1d7ca570…/sessions/d8883185…/events.jsonl` + user-pasted tool-failure stats. Note: that userData directory was removed/relocated mid-session and could not be re-read afterwards.

| Telemetry item | Reconciliation |
|---|---|
| 5× `terminal: exit 1` (`vitest run agentLoopSa…`, `chatVie…`) | Matches the stale 16:52 failures already documented in §3 (conflictedPaths/writeConflictedPaths ReferenceErrors, toolWebFetch, "1/10 saved", docs opencode). Session `d8883185`'s own assistant messages recorded "full pnpm test exits 1 (7 failures / 4 files)" then 20 failures. **All fixed in the current tree** — fresh full-suite run passes. Historical record of mid-fix iterations, not current state. |
| 2× `Get-CimInstance` exit 1 | PowerShell cmdlet failing when issued through a bash-resolved shell (MSYS). Suspected model/shell mismatch, not an app bug. Unverifiable now (logs gone). |
| 1× `mcp_list_tools`: "github: Sign in required" | Working as designed — GitHub MCP requires OAuth sign-in. |
| 1× `multi_edit`: "duplicate path" | Schema duplicate-path guard correctly rejecting; guard functioning, not a bug. |
| Session churn | 5+ compaction/re-orientation cycles at 14:01 — resume loop works; churn was driven by repeated re-runs of the then-failing suite. |

## 6. Addendum 2: full userData + log audit (2026-08-27 22:3x, folder re-appeared)

`%APPDATA%/vyotiq` returned after an app relaunch. Audited in full: 2 workspaces, 4 sessions, `logs/vyotiq.log` (Aug 26 12:02 → Aug 27 21:23), `crash-history.json`, `notifications.json`.

**Sessions (workspace `1d7ca570` = this repo):**
- `d8883185` "flush title bar edge-to-edge" — **236 steps**, 4 user messages, 364 tool calls, 25 failed, status **cancelled** by user ("finish work" run). Receipt v5: failure clusters match the user-pasted telemetry exactly (5× agentLoopSafety vitest, 4× chatView.placement, 2× Get-CimInstance, mcp sign-in, multi_edit dup, 2× read past-EOL). One **`COMPACTION` error: "The model returned no summary"** (archive 12:22). 1 compaction (not 5 — the "re-orient" churn was assistant messages, not compaction events). `unreadEditPaths: tests/renderer/chat/scratchBisect.test.tsx` — a **leftover bisection scratch file still present in the working tree** (untracked cleanup candidate). Terminal shell: **168/168 PowerShell**; only 2 hit not-recognized/ParserError.
- `80f97606` "goal banner above user prompt" — 30 steps, 42 calls, 2 failed (one real: `update_goal` called with no `create_goal` first — logged as `TOOL_EXEC` error 14:20 Aug 26), status **done**. wroteFiles 3, no unread edits.
- `2c90e1a6` (home dir) `7abe545c` — "Hi" smoke test, 1 call, done.

**Log findings (`logs/vyotiq.log`):**
- 5 `[error]` entries: MCP OAuth "does not support dynamic client registration" (Aug 26 12:14 — GitHub MCP needs static client config, matching `oauthStaticClient.ts` design), the `update_goal` no-goal error, 2× `read` startLine-past-EOL (agent error, handled), `Unknown terminal session_id` after app restart (working as documented — background shells don't survive restart).
- 33× `[state] Skipping invalid events.jsonl line (json) { line: 1 }` (Aug 27 17:55+): **a recurring events.jsonl parse warning worth investigating** — line 1 of some events file is repeatedly invalid JSON; benign (skipped) but suggests a writer interleaving/tearing issue or a non-JSON first line.
- 9× `Circuit opened` (provider circuit breaker firing), 2× `Compaction stream error`, 1× `Compaction produced no summary despite eligible history` — consistent with the COMPACTION error above; retry path worked (run continued).
- Provider probe `ollama ECONNREFUSED` at boot (expected, no local Ollama); crash-history empty (no crashes); the run used `openrouter/stealth-ox-alpha`.

**Cross-check vs audit §2/§3:** telemetry confirms the failure taxonomy already documented; adds one new item — the recurring `Skipping invalid events.jsonl line (json)` warning (new finding, low severity, logged for follow-up) and the leftover `scratchBisect.test.tsx` (cleanup).

## 7. Addendum 3: all §6 findings fixed (2026-08-28, commit `628c8b2`)

| Finding | Disposition |
|---|---|
| `Skipping invalid events.jsonl line (json) line 1` (33×) | **Fixed.** Root cause: `readFileTailSync` (`state.ts:700-703`) kept the partial text when the tail window contained no newline — reachable when the window starts mid-line (stale size vs. a concurrently rotated file) or is clamped to an in-flight tail line. Now returns no events instead of parsing a partial line. Regression test added (`runsState.test.ts`: 120KB single-line file, 64KB window → 0 events). |
| `COMPACTION: The model returned no summary` (run killed) | **Fixed.** `summarizeWithTimeoutRetry` now performs one flattened `tools=[]` retry on a transient empty response (no timeout/abort), mirroring the existing timeout retry; still terminal if the retry is empty. Regression test added (`executeCompactVerify.test.ts`: empty first call → faithful second call → verified compaction). |
| `update_goal` no-goal guard (wasted step) | Guard behavior is correct (self-explanatory error, model recovered); `update_goal` schema description now states the `create_goal` precondition so models don't burn a step discovering it. |
| `scratchBisect.test.tsx` leftover | **Removed.** Untracked, self-labeled "TEMPORARY bisection scratch", identical assertions already covered by `chatView.errors.test.tsx:100-120`; its standalone run also hangs (ChatView+jsdom isolation-hang class, documented in §4/B1). |
| `rulesInjection` flake (2 tests, one full run) | **Not reproducible** (passes in isolation and in subsequent runs). Code review found no mechanism for stale-cache-after-clear: `clearRulesCache(workspace)` empties the key the read uses, and no in-flight promise dedupe exists. Documented as observed-once; no code change. Re-check on next full suite run. |

Verification for this addendum: targeted suites 88/88 (`runsState`, `executeCompactVerify`, `toolsSchema`, `compactRun`, `eventAppendQueue`); `tsc` node+web clean; `eslint` clean on all touched files. Committed as `628c8b2`.
