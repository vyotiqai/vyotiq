# Agent-Run Failure Root Fixes — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Fix the 8 distinct tool-failure classes observed in real agent runs (codebase_search lexical-only degradation, merge_agent_instance clean-tree refusal, github_pr_create gate denial with no guidance, LSP initialize failure on TS 7 workspaces, browser_wait_for_url blind timeouts, browser_hover stale-ref churn, plan-mode edit denials on non-artifact plan paths, and missing loop-coaching for all of the above) with focused, verified root fixes — no new tools, no bloat, no schema-count changes.

**Architecture:** All fixes are main-process only. Engine fixes land where the failure originates (codeindex search self-heal, instanceWorktree merge gate, gh preflight, lspService server args, agentBrowser timeout diagnostics, modePolicy artifact matcher); agent-behavior coaching lands in the existing `loopPolicy` failure-guidance chain, which is exactly what it is for. No renderer changes, no tool-registry changes (61-tool parity tests untouched), no removed-UI files touched.

**Tech Stack:** TypeScript (strict), Vitest (`globals: false`), Electron main process, node-pty-free unit tests. Run tests per `vyotiq-agent-v` skill: `node node_modules/vitest/vitest.mjs run <files>` (pnpm invocation is broken in this shell).

---

## Current context / verified evidence

Every claim below was verified by reading the code on 2026-08-30 (branch `main`, clean, `b552404`):

| # | Failure | Root cause verified at |
|---|---------|------------------------|
| 1 | `codebase_search` → "Query embedder does not match the indexed model" (lexical-only) | `src/main/agent/tools/codebaseSearch.ts:40-58` computes `queryIndexMismatch` and degrades; `src/main/agent/codeindex/index.ts:891-907` (fast path) and `:832-875` (queued path) resolve the query embedder fresh but **never reconcile a mismatched index** — no self-heal re-sync exists. Sync *can* re-embed on model change (`src/main/agent/codeindex/sync.ts:227-243` uses `denseModelIdsCompatible`), it is just never triggered on mismatch. `resolveEmbedder` already returns `usedFallback` (`index.ts:194-197`) which callers discard. |
| 2 | `merge_agent_instance` requires a fully clean parent tree | `src/main/git/instanceWorktree.ts:1048-1058`: `git status --porcelain` non-empty → refuse. Untracked scratch files (`.hermes/plans/…`, notes) produce `??` entries and wedge merges even though a merge cannot clobber untracked files (git aborts safely if a branch would overwrite one — handled by the existing merge-failure abort at `:1066-1077`). |
| 3 | "GitHub PR write not executed — safety gate (needs explicit push/auth to the real remote)" | `github_pr_create` is autonomous-high-risk by design (`src/main/agent/toolApproval.ts:153`); denial reason surfaces via the approval gate (`toolApproval.ts:346-360`). `prCreate` (`src/main/git/gh.ts:446-472`) pushes + `gh pr create` with no `gh auth status` preflight, so failures deep in push are opaque. `loopPolicy.ts` has **no** guidance entry for PR denials → agent retries a permanently-denied call. |
| 4+8 | `lsp` → "Request initialize failed: Could not find a valid TypeScript installation" | Repo has `typescript@7.0.2` (`node_modules/typescript/lib/` contains `tsc.js` only — **no `tsserver.js`**). `src/main/workspace/lspService.ts:41-49` runs `typescript-language-server --stdio`, resolved from workspace `.bin` then PATH (global 5.9.2 exists: `where.exe tsserver` → `%APPDATA%\npm\tsserver.cmd`; `where.exe typescript-language-server` → also on PATH). typescript-language-server resolves the *workspace* TS first, finds no `lib/tsserver.js`, and fails initialization. Global TS 5.9.2 has the SDK at `%APPDATA%\npm\node_modules\typescript\lib`. typescript-language-server supports pointing at an SDK explicitly (verify the exact flag — `--tsserver-path` — against its `--help` in Task 0 before wiring). |
| 5 | `browser_wait_for_url` ×3 "Timed out after 10000ms waiting for URL matching /secure (last: the-in…" | Timeout itself works (`src/main/app/agentBrowser.ts:2037-2072`, `clampWaitTimeout` at `:1858-1860`, default 15s, caller passed 10000). The error tells you the last URL but **not the page state**, and `loopPolicy.ts` has no coaching entry → the agent re-issued identical waits (3×). |
| 6 | `browser_hover` "Unknown snapshot ref @e5" | `agentBrowser.ts:1184-1189` throws when `tab.lastRefs` lacks the ref; refs are wiped on every navigation (`:643-650`, `:860`, `:1987`). Correct behavior, but no loopPolicy coaching → agent re-tried the stale ref instead of re-snapshotting. |
| 7 | `edit` "Plan mode may only edit plan.md or contract.md" | Working-as-designed gate at `src/main/agent/tools/modePolicy.ts:285-295` + `isPlanArtifactPath` at `:72-75` (basename must be exactly `plan.md`/`contract.md`). Timestamped plan artifacts (e.g. `.hermes/plans/2026-08-30_090537-foo.md`) are still plan artifacts by definition but are denied. LoopPolicy already coaches the plain case (`loopPolicy.ts:270-273`). |

**Constraints (user-directed, binding):** no unnecessary bloat or complexity; only focused, real, verified root fixes; everything fully wired and verified end-to-end; no assumptions, no faking — every step below states its expected output.

**Repo constraints:** `.cursorrules` + AGENTS.md in force. `tests/main/unit/toolsSchema.test.ts` enforces the 61-tool registry parity — none of these changes add/remove tools. Never touch the removed-UI file list. Never bulk-revert the working tree. Verify with: typecheck BOTH configs, targeted vitest, eslint (commands per task; `pnpm` CLI is broken in this MSYS shell — call node binaries directly).

---

## Task 0: Preflight verification (read-only, ~5 min)

**Objective:** Confirm the three runtime facts the fixes depend on, so no step later assumes.

**Steps:**
1. `node_modules/typescript-language-server` flag check:
   Run: `npx typescript-language-server --help | grep -i tsserver` (or `node node_modules/typescript-language-server/lib/cli.js --help`). If repo-local binary is absent, `where.exe typescript-language-server` → run the global one.
   Expected: a flag matching `--tsserver-path`. If the flag does not exist, STOP task 5 and re-plan that task around `initializationOptions` instead.
2. Global SDK presence: `ls "$APPDATA/npm/node_modules/typescript/lib/tsserver.js"` → Expected: exists (TS 5.9.2).
3. Approval-denial summary text: read `src/main/agent/toolApproval.ts:346-378` and how denial content flows into `loopPolicy`'s `recent.summary` (see `runReceipt.ts` / `loopPolicy.ts:220-310`). Record the exact string shape a `github_pr_create` denial produces (needed for Task 7's regex — no guessing).

**Files:** none changed.

---

## Task 1: codebase_search self-heal on query/index model mismatch

**Objective:** When the query embedder differs from the indexed model *and the query embedder is the configured one (not a fallback)*, force one re-sync (which re-embeds on model change) and retry the search once, so search converges to semantic instead of staying lexical. Fallback embedders must NOT trigger re-sync (preserves the existing `keptNeural` preservation semantics).

**Files:**
- Modify: `src/main/agent/codeindex/index.ts` (fast path ~:891-907; queued path ~:832-875; add `denseModelIdsCompatible` to the `'./types'` import at :30-38)
- Modify: `src/main/agent/tools/codebaseSearch.ts:52-58` (message: note self-heal when it happened)
- Test: `tests/main/unit/codeindex.searchQueue.test.ts` (extend) or new `tests/main/unit/codeindex.selfheal.test.ts`

**Step 1: Write failing tests** (follow existing mock style in `codeindex.searchQueue.test.ts`):

```ts
// Case A: index model differs, query embedder is configured (usedFallback=false)
//   → expect: ensureCodeIndexSynced called with force:true, second search runs, result NOT lexical-only.
// Case B: index model differs, query embedder is a fallback (usedFallback=true)
//   → expect: NO forced sync; result is lexical with the existing note (current behavior preserved).
// Case C: models compatible (denseModelIdsCompatible true) → no forced sync.
```

**Step 2: Run to verify failure.**
Run: `node node_modules/vitest/vitest.mjs run tests/main/unit/codeindex.searchQueue.test.ts`
Expected: FAIL — self-heal path does not exist.

**Step 3: Implement** (sketch — read the live code before editing):

- Thread `usedFallback` through both paths: fast path `const { embedder, usedFallback } = await resolveEmbedder({...})` (currently destructures only `embedder` at :891); queued path same at :832.
- Add a local helper inside `index.ts`:

```ts
function indexModelMismatch(statusModelId: string, embedder: Embedder): boolean {
  if (isHashEmbedderModelId(embedder.modelId)) return false
  const stored = statusModelId.trim()
  if (!stored) return false
  return !denseModelIdsCompatible(stored, embedder.modelId)
}
```

- Queued path: after the first `runCodeIndexSearch` (:847-851), `if (indexModelMismatch(status.modelId, embedder) && !usedFallback)` → `await ensureCodeIndexSyncedUnlocked(workspaceRoot, { signal: searchSignal, preferOllama: opts.preferOllama, embedderId: opts.embedderId, force: true })` then retry the search once (mirror the existing cold-sync retry block at :852-873). Guard with a local boolean so it can fire at most once per call.
- Fast path: after first search (:897-901), if mismatch && !usedFallback && status.ready && chunkCount > 0 → fall through to `runQueuedInteractiveSearch` with a forced-sync variant (extend the queued runner with an internal `forceResync` flag rather than duplicating logic).
- `codebaseSearch.ts`: when the header notes a mismatch, append `; re-syncing index to the query embedder` when the self-heal fired (thread a boolean back in `CodebaseSearchResult` if needed — smallest change wins).

**Step 4: Run tests to verify pass.**
Run: `node node_modules/vitest/vitest.mjs run tests/main/unit/codeindex.searchQueue.test.ts tests/main/unit/codeindex.retrieval.test.ts tests/main/unit/toolsBudget.test.ts tests/main/unit/modePolicy.test.ts`
Expected: PASS (incl. the codebase_search consumers).

**Step 5: Commit**
```bash
git add src/main/agent/codeindex/index.ts src/main/agent/tools/codebaseSearch.ts tests/main/unit/codeindex.searchQueue.test.ts
git commit -m "feat(codeindex): self-heal query/index embedder mismatch with one forced re-sync"
```

---

## Task 2: merge_agent_instance — allow untracked-only parent trees

**Objective:** Replace the blanket "fully clean" gate with a *tracked-changes* gate. Untracked files (`??`) can never be clobbered by a merge (git refuses and the existing abort path handles it); untracked scratch must not wedge instance merges.

**Files:**
- Modify: `src/main/git/instanceWorktree.ts:1048-1058` (the dirty check inside `mergeInstanceBranchUnlocked`)
- Test: `tests/main/unit/instanceWorktree.test.ts` (extend)

**Step 1: Write failing tests:**

```ts
// Case A: parent has only untracked files (?? entries) → merge proceeds.
// Case B: parent has a tracked modification ( M) → refuses, error lists the path(s).
// Case C: parent has a staged addition (A ) → refuses.
// Case D: empty status → proceeds (existing behavior).
```

**Step 2: Run to verify failure.**
Run: `node node_modules/vitest/vitest.mjs run tests/main/unit/instanceWorktree.test.ts`
Expected: FAIL — Case A refuses today.

**Step 3: Implement** — replace the dirty check with a porcelain-line parse (non-`-z` v1; renames only affect display, and detection only needs the XY columns):

```ts
try {
  const status = await git(['status', '--porcelain=v1', '-uall'], workspacePath, READ_TIMEOUT_MS)
  const blocked: string[] = []
  for (const line of status.split(/\r?\n/)) {
    if (line.length < 4) continue
    const xy = line.slice(0, 2)
    if (xy.trim() === '' || xy === '??') continue // untracked: merge cannot overwrite it (git aborts if it would)
    blocked.push(line.trim())
  }
  if (blocked.length > 0) {
    const shown = blocked.slice(0, 5).join(', ') + (blocked.length > 5 ? `, +${blocked.length - 5} more` : '')
    return {
      ok: false,
      error: `Parent worktree has uncommitted tracked changes (${shown}). Commit or stash them, then merge one instance branch at a time.`
    }
  }
} catch (err) { /* keep the existing catch shape */ }
```

**Step 4: Run tests to verify pass.**
Run: `node node_modules/vitest/vitest.mjs run tests/main/unit/instanceWorktree.test.ts tests/main/unit/agentInstances.test.ts`
Expected: PASS.

**Step 5: Commit**
```bash
git add src/main/git/instanceWorktree.ts tests/main/unit/instanceWorktree.test.ts
git commit -m "fix(git): allow untracked-only parent trees when merging instance branches"
```

---

## Task 3: github_pr_create — auth preflight with an actionable error

**Objective:** Fail fast with a precise message when `gh` is unauthenticated, instead of an opaque push failure mid-flight. The approval gate itself stays exactly as-is (high-risk classification is correct and stays).

**Files:**
- Modify: `src/main/git/gh.ts:446-456` (`prCreate`: add preflight before `assertPrRepository`)
- Test: `tests/main/unit/gh.test.ts` (extend)

**Step 1: Write failing test:**

```ts
it('prCreate fails fast when gh is not authenticated', async () => {
  // mock gh(['auth','status',…]) → non-zero with 'not logged in'
  await expect(prCreate('/ws')).rejects.toThrow(/gh is not authenticated/i)
})
```

**Step 2: Run to verify failure.**
Run: `node node_modules/vitest/vitest.mjs run tests/main/unit/gh.test.ts`
Expected: FAIL.

**Step 3: Implement** — at the top of `prCreate`:

```ts
try {
  await gh(['auth', 'status'], cwd, AUTH_STATUS_TIMEOUT_MS) // reuse an existing short timeout constant
} catch {
  throw new Error(
    'gh is not authenticated for this machine. Run `gh auth login` (or set GH_TOKEN), then retry the PR.'
  )
}
```

Check `setupGithubGitAuth` (`gh.ts`) first during implementation: if it already guarantees auth and surfaces a clear error, keep the preflight only when it adds a clearer message — do not double-gate (evidence-first: Task 0/implementation reads decide; if redundant, shrink this task to the loopPolicy coaching in Task 7 only and note why).

**Step 4: Run tests to verify pass.**
Run: `node node_modules/vitest/vitest.mjs run tests/main/unit/gh.test.ts`
Expected: PASS.

**Step 5: Commit**
```bash
git add src/main/git/gh.ts tests/main/unit/gh.test.ts
git commit -m "fix(gh): authenticated preflight for PR create with actionable error"
```

---

## Task 4: LSP — point typescript-language-server at a valid TS SDK on TS 7 workspaces

**Objective:** When the workspace TypeScript lacks `lib/tsserver.js` (TS 7), spawn `typescript-language-server` with `--tsserver-path` pointing at a workspace or global TS 5.x SDK, so `initialize` succeeds. No TypeScript version changes in the repo.

**Files:**
- Modify: `src/main/workspace/lspService.ts` (CANDIDATES flow: `detectServer` :132-146, spawn at `startInternal` :341)
- Test: new pure-helper tests inside `tests/main/unit/lspTool.test.ts` or a new `tests/main/unit/lspService.tsserverPath.test.ts` (pure logic only; no child spawn in tests)

**Step 1: Write failing tests** for the pure helpers you will add:

```ts
// pickTsserverPath({ workspaceLib: string, globalLib: string | null }): string | null
//  - workspaceLib has tsserver.js → return null (server finds the workspace SDK itself)
//  - workspaceLib lacks it and globalLib has tsserver.js → return globalLib
//  - neither → null (keep today's behavior)
// buildLspArgs(baseArgs: string[], tsserverLib: string | null): string[]
//  - tsserverLib → [...baseArgs, `--tsserver-path=${tsserverLib}`]
```

**Step 2: Run to verify failure.**
Run: `node node_modules/vitest/vitest.mjs run tests/main/unit/lspTool.test.ts`
Expected: FAIL — helpers don't exist.

**Step 3: Implement:**

- `resolveTsserverPath(workspacePath): Promise<string | null>`:
  1. `join(workspacePath, 'node_modules', 'typescript', 'lib')` — if it contains `tsserver.js`, return `null` (no flag needed).
  2. Global: `execFile('npm', ['root', '-g'])` (2s timeout, `windowsHide: true`, reuse `LSP_PROBE_TIMEOUT_MS` style), cached in a module-level variable; append `typescript/lib`; return it iff `tsserver.js` exists there.
  3. Otherwise `null`.
- In `detectServer`, for the `typescript` candidate only: compute the path and build `args` via `buildLspArgs(candidate.args, path)` so `DetectedLspServer.args` carries the flag (the `clientKey` uses `server.id` + executable, so cache identity is unaffected by arg changes).
- **Gate on the Task 0 flag verification.** If typescript-language-server's flag differs, use the verified flag; if none exists, stop and re-plan (do not ship a guessed flag).

**Step 4: Run tests to verify pass.**
Run: `node node_modules/vitest/vitest.mjs run tests/main/unit/lspTool.test.ts`
Expected: PASS.

**Step 5: End-to-end verification (required — this fix is about a real handshake):**
Run a one-shot script spawning the global `typescript-language-server` with `--tsserver-path=$APPDATA/npm/node_modules/typescript/lib --stdio`, send an `initialize` request over stdin LSP framing, and assert an `initialize` **result** (not an error) comes back within 10s. Save as scratch under `$LOCALAPPDATA/Temp`, not the repo. Expected: result JSON with `capabilities`.
Then (manual, optional): in the built app, run the `lsp` tool with `action:"diagnostics"` on `src/shared/logger.ts` and confirm "No diagnostics." or real diagnostics instead of the initialize failure.

**Step 6: Commit**
```bash
git add src/main/workspace/lspService.ts tests/main/unit/lspTool.test.ts
git commit -m "fix(lsp): resolve a valid TS SDK for typescript-language-server on TS7 workspaces"
```

---

## Task 5: browser_wait_for_url — page title in the timeout error

**Objective:** Make the timeout actionable: include the page title alongside the last URL so a wrong-state page (error page, still on login) is diagnosable in one look. No timeout semantics change.

**Files:**
- Modify: `src/main/app/agentBrowser.ts:2062-2071` (`waitForUrlUnlocked` timeout throw)
- Test: extract a pure formatter and test it in `tests/main/unit/executeToolGitDiagBrowser.test.ts` (which already stubs the browser module)

**Step 1: Write failing test:**

```ts
// formatWaitTimeoutMessage({ kind: 'url', needle, regex, url, title, timeoutMs })
// → 'Timed out after 10000ms waiting for URL matching "/secure" (last: https://…, title: "Sign in")'
// title: null → omitted from the message (matches today's shape when no title is available)
```

**Step 2: Run to verify failure.**
Run: `node node_modules/vitest/vitest.mjs run tests/main/unit/executeToolGitDiagBrowser.test.ts`
Expected: FAIL.

**Step 3: Implement:** in the timeout branch, best-effort `const title = await tabContents(tab).executeJavaScript('document.title', true).catch(() => null)` (one call, only on the error path — no per-poll cost), then format via the helper. Keep `JSON.stringify` quoting for both URL and title.

**Step 4: Run tests to verify pass.**
Run: `node node_modules/vitest/vitest.mjs run tests/main/unit/executeToolGitDiagBrowser.test.ts`
Expected: PASS.

**Step 5: Commit**
```bash
git add src/main/app/agentBrowser.ts tests/main/unit/executeToolGitDiagBrowser.test.ts
git commit -m "fix(browser): include page title in wait_for_url timeout diagnostics"
```

---

## Task 6: Plan-mode artifact matcher — accept `.hermes/plans/*.md`

**Objective:** Plan-mode agents can write plan artifacts under `.hermes/plans/` (timestamped plan files are plan artifacts by definition), while product-code denial stays intact.

**Files:**
- Modify: `src/main/agent/tools/modePolicy.ts:72-75` (`isPlanArtifactPath`)
- Test: `tests/main/unit/modePolicy.test.ts:74-78` (extend)

**Step 1: Write failing tests:**

```ts
expect(isPlanArtifactPath('.hermes/plans/2026-08-30_090537-agent-fixes.md')).toBe(true)
expect(isPlanArtifactPath('.hermes/plans/x.md')).toBe(true)
expect(isPlanArtifactPath('.hermes/plans/sub/deep.md')).toBe(false)   // one level only (YAGNI)
expect(isPlanArtifactPath('.hermes/notes.md')).toBe(false)
expect(isPlanArtifactPath('src/app.ts')).toBe(false)                  // unchanged
```

**Step 2: Run to verify failure.**
Run: `node node_modules/vitest/vitest.mjs run tests/main/unit/modePolicy.test.ts`
Expected: FAIL.

**Step 3: Implement** (keep existing basename logic first, then the prefix):

```ts
export function isPlanArtifactPath(pathArg: string): boolean {
  const p = pathArg.replace(/\\/g, '/').replace(/^\.\//, '')
  if (PLAN_ARTIFACT_NAMES.has(basename(p))) return true
  return /^\.hermes\/plans\/[^/]+\.md$/i.test(p)
}
```

**Step 4: Run tests to verify pass.**
Run: `node node_modules/vitest/vitest.mjs run tests/main/unit/modePolicy.test.ts tests/main/unit/loopPolicy.test.ts tests/main/unit/runReceipt.test.ts`
Expected: PASS (these suites assert the plan-mode denial strings — confirm no message text changed).

**Step 5: Commit**
```bash
git add src/main/agent/tools/modePolicy.ts tests/main/unit/modePolicy.test.ts
git commit -m "feat(modePolicy): allow .hermes/plans/*.md as Plan-mode write artifacts"
```

---

## Task 7: loopPolicy coaching for the new failure classes

**Objective:** One-shot behavioral guidance so the agent stops retrying dead ends (stale refs, blind URL waits, denied PRs, lexical-only search). This is the existing architecture's designated place for it (`loopPolicy.ts:220-305` if/else chain).

**Files:**
- Modify: `src/main/agent/loopPolicy.ts` (add branches to the chain)
- Test: `tests/main/unit/loopPolicy.test.ts` (extend)

**Step 1: Write failing tests** (one per branch, using the established test fixtures at :131/:227):

```ts
// browser_hover + /Unknown snapshot ref/ → 'refs reset on navigation; call browser_snapshot again and use a fresh @eN ref'
// browser_wait_for_url + /Timed out .* waiting for URL/ → 'do not repeat the same wait; snapshot to see actual page state, fix the cause, then wait for the new URL'
// github_pr_create + denial text (exact regex from Task 0 finding) → 'do not retry; report ready branch/commits and let the user create the PR'
// codebase_search + /does not match the indexed model|lexical-only/ → 'index re-syncs to the configured embedder; retry after re-index completes or align Settings → Indexing'
```

**Step 2: Run to verify failure.**
Run: `node node_modules/vitest/vitest.mjs run tests/main/unit/loopPolicy.test.ts`
Expected: FAIL.

**Step 3: Implement** — four `else if` branches matching the chain's existing shape (`recent?.tool === '…' && /regex/.test(recent.summary)`), each pushing ONE sentence. Use the exact denial-summary regex recorded in Task 0 step 3 — do not guess it.

**Step 4: Run tests to verify pass.**
Run: `node node_modules/vitest/vitest.mjs run tests/main/unit/loopPolicy.test.ts tests/main/unit/runReceipt.test.ts`
Expected: PASS.

**Step 5: Commit**
```bash
git add src/main/agent/loopPolicy.ts tests/main/unit/loopPolicy.test.ts
git commit -m "feat(agent): loop guidance for stale refs, wait timeouts, PR denials, lexical search"
```

---

## Task 8: Full verification gate (end-to-end)

**Objective:** Prove every fix compiles, passes its suites, and nothing regressed.

**Steps:**
1. Typecheck BOTH configs (real gate):
   Run: `node ./node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit && node ./node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit`
   Expected: zero errors.
2. Targeted vitest, main batch:
   Run: `node node_modules/vitest/vitest.mjs run tests/main/unit/codeindex.searchQueue.test.ts tests/main/unit/codeindex.retrieval.test.ts tests/main/unit/instanceWorktree.test.ts tests/main/unit/agentInstances.test.ts tests/main/unit/gh.test.ts tests/main/unit/lspTool.test.ts tests/main/unit/executeToolGitDiagBrowser.test.ts tests/main/unit/modePolicy.test.ts tests/main/unit/loopPolicy.test.ts tests/main/unit/runReceipt.test.ts tests/main/unit/toolsSchema.test.ts tests/main/unit/toolsBudget.test.ts`
   Expected: all PASS (toolsSchema included to prove the 61-tool registry parity is untouched).
3. Renderer spot-check (no renderer changes expected, but the tool-summary/meta files reference touched tool names):
   Run: `node node_modules/vitest/vitest.mjs run tests/shared/toolSummary.test.ts tests/shared/mergeAgentInstanceUpdate.test.ts`
   Expected: PASS.
4. Lint:
   Run: `node ./node_modules/eslint/bin/eslint.js src/main/agent/codeindex/index.ts src/main/agent/tools/codebaseSearch.ts src/main/git/instanceWorktree.ts src/main/git/gh.ts src/main/workspace/lspService.ts src/main/app/agentBrowser.ts src/main/agent/tools/modePolicy.ts src/main/agent/loopPolicy.ts`
   Expected: zero errors.
5. Manual end-to-end (only where a unit test cannot reach): the LSP initialize handshake (Task 4 step 5) and, if the dev app is running anyway, one `merge_agent_instance` against an untracked-only tree in a scratch repo.

**Commit:** none (verification only). If any gate fails, fix the offending task before finishing — do not weaken tests.

---

## Files likely to change (complete list)

- `src/main/agent/codeindex/index.ts`
- `src/main/agent/tools/codebaseSearch.ts`
- `src/main/git/instanceWorktree.ts`
- `src/main/git/gh.ts`
- `src/main/workspace/lspService.ts`
- `src/main/app/agentBrowser.ts`
- `src/main/agent/tools/modePolicy.ts`
- `src/main/agent/loopPolicy.ts`
- Tests: `codeindex.searchQueue.test.ts` (or new `codeindex.selfheal.test.ts`), `instanceWorktree.test.ts`, `gh.test.ts`, `lspTool.test.ts` (or new `lspService.tsserverPath.test.ts`), `executeToolGitDiagBrowser.test.ts`, `modePolicy.test.ts`, `loopPolicy.test.ts`

**Never touched:** anything on the removed-UI list; `src/main/agent/schemas/tools.ts` (no tool-schema changes → 61-count parity holds); renderer sources; docs `.docx`.

## Risks / tradeoffs / open questions

1. **Self-heal re-embed cost (Task 1):** forcing a sync re-embeds the index when the configured embedder changed. This is bounded by existing sync paging and only fires when the query embedder is *not* a fallback, so fallback flip-flop (LFM2 temporarily down → LightOn) can't erase an LFM2 index. Tradeoff accepted: one bounded re-sync beats silently lexical search forever.
2. **Merge gate widening (Task 2):** allowing untracked files means a merge can still fail if the branch adds a file that exists untracked in the parent — that path already aborts cleanly with a clear git error (existing `:1066-1077` handler). Tracked changes remain hard-blocked; no review-safety loss.
3. **`--tsserver-path` flag (Task 4):** verified against the installed CLI in Task 0 before any wiring; if the flag doesn't exist, that task is re-planned (initializationOptions route) rather than shipped on a guess.
4. **Plan-artifact widening (Task 6):** strictly widens Plan-mode writes to `.hermes/plans/*.md` only, one level deep. Product-code denial surface and all existing denial strings are unchanged (asserted by `loopPolicy`/`runReceipt` suites).
5. **Open question:** should `resources/harness/default.md` gain a line about plan artifacts under `.hermes/plans/`? Out of scope by default (harness edits are behavioral-contract changes); raise with the user after Tasks 1-7 land.
6. **Task 3 may shrink:** if implementation shows `setupGithubGitAuth` already yields a clear auth error, the preflight is redundant — keep only the loopPolicy coaching and record why in the commit body.
