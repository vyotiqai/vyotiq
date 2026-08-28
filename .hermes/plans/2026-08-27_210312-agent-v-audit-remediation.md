# Remediation Plan — Audit Findings (Agent V)

> **STATUS (2026-08-27, executed):** Tasks 1–5 + 7 implemented and verified; committed as `a80352c fix(tools): restore resource caps, make test suite exit, align CI pins`.
> - Task 1 ✅ 64KB terminal cap (foreground + background sessions) + test (10MB dump → bounded, notice shown)
> - Task 2 ✅ 2MB webFetch cap (fetchPinnedPublic + readBody) + test (3MB body → ≤2MB buffered)
> - Task 3 ✅ 16-tab browser cap (ensureTab / browser_tabs open / window-open deny)
> - Task 4 ✅ (mitigation) `scripts/test-exit-wrapper.cjs` wired into `pnpm test`; verified exit 0 green, exit 1 on failing suite, deterministic exit after summary+grace. Permanent fix (per-suite teardown hygiene) still open.
> - Task 5 ✅ CI pnpm 11.22.0 → 11.24.0 (both workflows)
> - Task 7 ✅ `CSC_IDENTITY_AUTO_DISCOVERY` from `CSC_LINK` presence folded into release.yml (behavior of fix/macos-unsigned-pack, minus its arm64/x64 matrix split — separate concern)
> - Task 6 ⏸ intentionally not executed: committing the user's 200+ in-flight files is their call.


**Goal:** Restore the resource limits stripped in commit `a067d81`, fix the local test-suite hang, and close the CI/packaging drift found in the 2026-08-27 audit (`.hermes/audits/2026-08-27_agent-v-full-audit.md`).

**Architecture:** No new subsystems. Reintroduce caps at the *capture* layer (terminal/webFetch/browser), add a test-suite exit hook, and align CI pins with `package.json`. Every change keeps the STRICT performance rule (measure, don't regress).

**Tech stack:** TypeScript (Electron main), Vitest, GitHub Actions.

**Constraints from AGENTS.md/.cursorrules:** evidence-minimal changes; fix forward (never restore from history); tool changes must update schema + handler + limits together (`tests/main/unit/toolsSchema.test.ts` guards counts); verify with `pnpm typecheck && pnpm test && pnpm lint` (run via `./node_modules/.bin/` on this host).

---

## Task 1: Cap terminal output capture at 64 KB (restores pre-`a067d81` behavior)

**Objective:** A command cannot balloon main-process memory via unbounded `stdout += text`.

**Files:**
- Modify: `src/main/agent/tools/terminal.ts:46` (constant), `terminal.ts:780-790` (capture loop), `formatTerminalOutput` call site
- Test: `tests/main/unit/terminalExecuteTool.test.ts` (add case)

**Steps:**
1. Write failing test: run `node -e "process.stdout.write('x'.repeat(10*1024*1024))"` via the tool; assert returned content length ≤ ~64 KB + framing and that the process did not OOM.
2. In `terminal.ts`, set `export const TERMINAL_MAX_OUTPUT = 64 * 1024` and in the `child.stdout.on('data')` / `child.stderr.on('data')` handlers: append only while `stdout.length < TERMINAL_MAX_OUTPUT` (compute `room = MAX - stdout.length`, slice the incoming text); skip work once at cap but keep draining (`.resume()`) so the pipe never backpressures the child.
3. Run: `./node_modules/.bin/vitest run tests/main/unit/terminalExecuteTool.test.ts` → pass.
4. Commit: `fix(tools): restore 64KB terminal output cap`

## Task 2: Re-arm the 2 MB web-fetch byte cap

**Objective:** `browser_search`/fetch cannot pull unbounded bytes into memory.

**Files:**
- Modify: `src/main/agent/tools/webFetch.ts:23` and the read/accumulate site that used `MAX_BYTES` (git show `a067d81` removed `const MAX_BYTES = WEB_FETCH_MAX_BYTES` + its `slice`)
- Test: `tests/main/unit/webFetch.test.ts` (add case)

**Steps:**
1. Failing test: mock `fetch` returning a 5 MB body; assert the tool result truncates at 2 MB (head window, with a `…[truncated]` marker consistent with `toolTrim.ts` style).
2. Restore `export const WEB_FETCH_MAX_BYTES = 2 * 1024 * 1024`; count bytes on the stream reader and abort with a clear truncation note when exceeded.
3. Run: `./node_modules/.bin/vitest run tests/main/unit/webFetch.test.ts` → pass.
4. Commit: `fix(tools): restore 2MB web fetch byte cap`

## Task 3: Restore a bounded browser tab count

**Objective:** Cap concurrent `WebContentsView`s.

**Files:**
- Modify: `src/main/app/agentBrowser.ts:38` (`MAX_BROWSER_TABS`) + the `open`/tab-create path that should reject/evict when at cap
- Test: `tests/main/unit/agentBrowserPolicy.test.ts` (add case; reuse existing tab-ownership test helpers)

**Steps:**
1. Failing test: with `MAX_BROWSER_TABS = 16`, opening a 17th tab must return a structured error ("tab limit reached") and leave existing tabs intact.
2. Set `export const MAX_BROWSER_TABS = 16`; enforce in the tab-create handler before allocating a `WebContentsView`.
3. Run: `./node_modules/.bin/vitest run tests/main/unit/agentBrowserPolicy.test.ts tests/main/unit/agentBrowserTabOwnership.test.ts` → pass.
4. Commit: `fix(browser): restore 16-tab cap`

## Task 4: Make `pnpm test` exit (fix the local hang)

**Objective:** Full vitest run must exit after the last file; today it sits idle >40 min (audit finding B1).

**Files:**
- Modify: `vitest.config.ts` (or `test` block in the config actually used): add `teardownTimeoutMS`, and a global `afterAll`/`onTestFinished` watchdog is NOT the fix — instead add `poolOptions.forks.execArgV` free investigation:
  1. Reproduce: `./node_modules/.bin/vitest run --reporter=basic --pool=forks --poolOptions.forks.singleFork` vs default pool; identify which suite leaks the handle (suspects from log: `ptyLifecycle`/`node-pty` conpty agent, `mcpIntegration` stdio servers, `git.test.ts` spawned processes).
  2. Root-cause the top offender (add `--detectOpenHandles`-equivalent via `vitest run --reporter=hanging-process` once, capture output, then fix the specific leak: e.g. `disconnect()` MCP clients in `afterEach`, `tree-kill` wait, or dispose pty sessions in test teardown).
  3. If the leak is in native `node-pty` itself and unfixable in-repo, add to the vitest config: `fakeTimers` off + `teardown` script that force-exits (`process.exit` in `globalTeardown`) — documented in a comment as a Windows ConPTY workaround.
- Test: existing suite; success criterion is `pnpm test` returning to the shell ≤ 10 min after last output.

**Steps:**
1. Run `./node_modules/.bin/vitest run --reporter=hanging-process > /tmp/hang.txt 2>&1` once; read the reported holders.
2. Fix the named leak(s) (expected: MCP stdio client `disconnect` in `tests/main/unit/mcpIntegration.test.ts` teardown; `disposeTerminalSessionsForInvoke` in pty tests).
3. Re-run full suite; confirm the shell returns. Run twice to confirm determinism.
4. Commit: `fix(test): exit vitest after full run (Windows handle leak)`

## Task 5: Align CI pnpm pin with package.json

**Objective:** Same pnpm version local and CI.

**Files:**
- Modify: `.github/workflows/ci.yml` (step "Enable pnpm": `corepack prepare pnpm@11.24.0`) — or better, replace both hardcoded lines with `corepack prepare $(node -p "require('./package.json').packageManager.split('+')[0]") --activate`-equivalent single source of truth. Check `release.yml` for the same pin and fix there too.

**Steps:**
1. Grep both workflows for `pnpm@`.
2. Change to read from `packageManager` (or literal `11.24.0` matching package.json).
3. Validate YAML parse locally (`node -e "..."` with a yaml parser or `actionlint` if available).
4. Commit: `ci: align pnpm pin with packageManager field`

## Task 6: Land the working tree

**Objective:** 209 uncommitted files (incl. the goal system, loop scheduler, docx tool, 30 untracked) must reach CI.

**Steps:**
1. Review `git status` grouping; ensure no `.env`/secrets and that new `.docx` doc additions are force-added per the `.gitignore` docx rule (AGENTS.md warning).
2. `git add` in logical groups (goal system, scheduler, docs, tests); run `./node_modules/.bin/tsc` + targeted tests once more before each commit batch.
3. Push to a branch, open PR, let the 3-OS CI matrix run (typecheck, coverage, lint, build, GUI e2e).
4. Commit(s): `feat: goal system, run-loop scheduler, docx text tool (audit task 6)`.

## Task 7 (follow-up, non-blocking): macOS signing parity

**Objective:** Deterministic macOS packaging without cert-file surprises (branch `fix/macos-unsigned-pack` exists for this).

**Files:** `.github/workflows/release.yml`, `electron-builder.yml` (mac target block).

**Steps:** Fold in the `fix/macos-unsigned-pack` branch change (skip signing identity when `CSC_LINK` absent, keep `--publish always` for win/linux); document in README that unsigned DMGs are expected without secrets. Commit: `ci(release): graceful unsigned macOS path`.

---

## Verification (whole plan)
- `./node_modules/.bin/tsc -p tsconfig.node.json --noEmit && ./node_modules/.bin/tsc -p tsconfig.web.json --noEmit`
- `./node_modules/.bin/vitest run` — full suite passes **and exits**
- `./node_modules/.bin/eslint .`
- Memory guard: `VYOTIQ_PERF=1` spot check that a 10 MB terminal dump no longer spikes RSS (measure before/after per performance rule)

## Risks / tradeoffs
- Re-imposing caps changes tool outputs for huge results (models will see truncation markers again — intended; mirrors pre-Aug-21 behavior and `toolTrim` precedent).
- The 16-tab cap can reject legitimate heavy multi-tab browsing — error message tells the agent to close tabs first (`browser_tabs close` exists).
- If the vitest hang root cause is node-pty native code, the documented globalTeardown force-exit is a pragmatic, clearly-commented workaround, not a silent `exit(0)`.
- Task 6 touches 200+ files — group commits so a CI failure bisects cleanly.

## Open questions
1. Was stripping the caps in `a067d81` intentional product policy ("output is no longer truncated" comment at `terminal.ts:45`)? If yes, propose per-tool opt-in limits in Settings instead of constants — decide before Task 1.
2. Should `run_tests`/`diagnostics` (already sandboxed) also surface a `--` separator for trailing flags, or is current parsing sufficient? (Not a finding — noted while auditing `parseSafeCommand`.)
