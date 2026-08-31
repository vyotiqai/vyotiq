# Agent V UX Polish (Root Fixes Only) Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Land and finish the half-landed workspace-switching/new-chat UX work already on disk, then fix the three *evidence-backed* interaction gaps that hurt people building websites/apps with Agent V — without adding any speculative features.

**Architecture:** All fixes are surgical changes to existing, verified code paths: the tool soft-deadline race in `executeStepTools.ts`, the loop coaching layer in `loopPolicy.ts`, the sandboxed HTML preview in `FilePreview.tsx`, and the agent-browser URL gate in `browserUrl.ts`/`agentBrowser.ts`. No new dependencies, no new screens, no harness bloat.

**Tech Stack:** Electron + React 19 (strict TS, Tailwind 4), vitest (`globals: false`), main-process Node.

---

## Evidence this plan is based on (all verified on disk, 2026-08-31)

| # | Observation | Source (real tool output this session) |
|---|---|---|
| E1 | 38 modified files + 3 untracked are **uncommitted UX work from run `82889e99`**, whose goal was exactly "workspace switching and adding new chat sessions is really bad" — status `done`, step 150. It includes Ctrl/Cmd+1..9 workspace switching, `onNewChatInWorkspace`, shortcuts tests, and more. Both tsconfigs green; 4 touched test files (129 tests) green. | `git status --short`, `git diff`, run receipt at `%APPDATA%/vyotiq/workspaces/1d7ca570.../sessions/82889e99-4509.../receipt.json`, `tsc -p tsconfig.node.json` exit 0, `tsc -p tsconfig.web.json` exit 0, vitest batch 4 files / 129 passed |
| E2 | `ask_question` was killed by the 10-min tool soft deadline **twice** across 16 runs; each deadline kill registers a tool failure, 4 consecutive failure-steps stop the run. A user simply being away from the desk can kill a whole run. | failureClusters across all 16 `receipt.json` files: `ask_question: Tool "ask_question" exceeded its 10-minute deadline...` ×2; `executeStepTools.ts` → `TOOL_SOFT_DEADLINE_MS = 10 * 60_000` applied to **all** tools via `raceToolDeadline` |
| E3 | `terminal` deadline kills ×2 with the same mechanism. The failure text already says "Split the work into smaller calls", but there is **no loopPolicy coaching branch for terminal deadlines** (verified branches exist only for edit/multi_edit/str_replace/old_string/duplicate-path shapes). Terminal supports background sessions; the model is never told to use them on this failure. | failureClusters `terminal: Tool "terminal" exceeded its 10-minute deadline...` ×2; `loopPolicy.ts` `loopHintForConsecutiveToolFailures` full read |
| E4 | For a web developer, an agent-generated HTML file previews with **`sandbox=""` (no scripts, no exceptions)** — `FilePreview.tsx` hard-codes it. Every JS-driven site preview renders dead. (Markdown remote images are NOT affected: `hast-util-sanitize@5.0.2/lib/schema.js:145` allows `img[src]` http/https — verified, so no work there.) | `src/renderer/src/features/chat/components/FilePreview.tsx:33-41`; sanitize schema grep |
| E5 | The agent browser refuses `file://` outright — `normalizeBrowserUrl` throws `Unsupported URL scheme: file:` — so the agent cannot open the site it just built in the workspace. | `src/main/app/browserUrl.ts:1-11`; `agentBrowser.ts` `navigateUrl` → `normalizeBrowserUrl` call verified |
| E6 | Dropped as "already handled" (no work planned): `multi_edit` duplicate-path (fail-fast error + loopPolicy branch both exist), remote markdown images (allowed by schema), receipts surfacing in UI (PlanPanel `ReceiptSummary` already shows failureClusters / unreadEditPaths / wroteFiles), empty-chat state (`emptyLabel` wired in ChatView → MessageList), diff syntax highlighting (Shiki per-side, 64-line cap, perf-gated). | direct reads listed in session transcript |

## Current context / assumptions

- Repo: `C:\Users\ajay\Documents\VYOTIQ - AGENT V\VYOTIQ - AGENT V`, branch `main`, ahead 2, 38 dirty files (E1).
- Shell is MSYS git-bash: invoke node binaries directly (`node node_modules/vitest/vitest.mjs`, `node ./node_modules/typescript/bin/tsc ...`, `node ./node_modules/eslint/bin/eslint.js .`) — `pnpm` is broken in this shell. Long gates → `terminal(background=true, notify=true)` + `process(wait)`.
- Large commit messages → write to `$LOCALAPPDATA/Temp/commit-msg.txt` via `write_file`, then `git commit -F`.
- CI-enforced removed-UI list (AgentSessionBar, ChatStartWork, …) must never reappear — `tests/renderer/chat/removedUiGuard.test.ts` guards it.
- Working tree is shared: re-run `git status` immediately before every staging step; stage explicit paths only; never bulk-revert.

**Files this plan will touch (complete list):**

- Modify: `src/main/agent/executeStepTools.ts` (Task 2)
- Modify: `src/main/agent/loopPolicy.ts` (Task 3)
- Modify: `src/renderer/src/features/chat/components/FilePreview.tsx` (Task 4)
- Modify: `src/main/app/browserUrl.ts`, `src/main/app/agentBrowser.ts` (Task 5)
- Tests: `tests/main/unit/agentLoopSteps.test.ts` (or the file where `raceToolDeadline` is pinned — re-verify), `tests/main/unit/loopPolicy.test.ts`, `tests/renderer/chat/filePreview.test.ts` (+ possible new `tests/renderer/chat/filePreview.sandbox.test.tsx`), `tests/main/unit/agentBrowserUrl.test.ts`, `tests/main/unit/agentBrowserPolicy.test.ts`
- Task 1 touches the existing dirty tree (commits only, no new edits beyond E1 verification).

---

### Task 1: Verify, finish, and commit the in-flight UX work (E1)

**Objective:** The workspace-switching/new-chat UX the user complained about is already built but sitting uncommitted. Make it real: verify every touched test file, run the full gates, then commit in dependency-ordered groups.

**Files:** the 38 dirty files listed in E1 (no new code, commits only).

**Step 1: Inventory the in-flight diff by subsystem**

Run: `git status --short && git diff --stat`
Expected: 38 modified + untracked `tests/main/unit/appUpdater.test.ts`, `tests/renderer/features/`, `.hermes/plans/...`. Read `git diff` for: `src/renderer/src/lib/shortcuts/bindings.ts` (Ctrl/Cmd+1..9), `src/renderer/src/app/sidebar/types.ts` (`onNewChatInWorkspace`), `src/main/app/updater.ts`, `src/shared/domain/reasoning.ts`, `src/shared/domain/transcript.ts`, `src/shared/utils/logPolicy.ts`, `src/main/agent/loop.ts`, `src/main/agent/state.ts`, `src/main/agent/tools/index.ts`, `src/main/agent/tools/terminal.ts`.

**Step 2: Run the affected test batches (split per skill quirks — never two gates concurrently)**

Run (renderer batch):
```
node node_modules/vitest/vitest.mjs run tests/renderer/chat/messageList.test.tsx tests/renderer/chat/thinkingBlock.test.tsx tests/renderer/sidebar/chatList.test.tsx tests/renderer/lib/shortcuts.test.ts
```
Expected: all pass (129 already verified across 4 of these files this session).

Run (main/shared batch):
```
node node_modules/vitest/vitest.mjs run tests/main/unit/agentLoopSteps.test.ts tests/main/unit/terminalInformativeResults.test.ts tests/main/unit/terminalShell.test.ts tests/main/unit/appUpdater.test.ts tests/shared/reasoning.test.ts tests/shared/transcript.test.ts tests/shared/errorsLogging.test.ts tests/renderer/features
```
Expected: all pass. If `tests/renderer/features` hangs (renderer batches can, per skill), split per top-level dir.

**Step 3: Full gates**

```
node ./node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit && node ./node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit
node ./node_modules/eslint/bin/eslint.js .
```
Expected: exit 0 (both tsconfigs already verified green this session; lint not yet run — this is its first gate).

**Step 4: Commit in groups, shared → main → renderer → chore, tests included in each group**

Re-check `git status --short` immediately before staging; stage exact paths only. Suggested groups (adjust to what the diff actually contains):
1. shared domain + logging (`src/shared/**` + `tests/shared/**`)
2. main agent/loop/terminal + updater (`src/main/**` + `tests/main/**`)
3. renderer UX (sidebar/shortcuts/ChatView/MessageList/ThinkingBlock/CommandPalette/settings + `tests/renderer/**`)
4. release/config chore (`.github/workflows/release.yml`, `electron-builder.yml`, `CONTRIBUTING.md`)

Commit messages via temp file + `git commit -F` (conventional subjects, body bullets with the why). After each commit on shared files, audit `git show <sha> -- <file>` for foreign hunks (parallel sessions commit mid-session — skill rule).

**Step 5: Verify the committed tree compiles while the worktree may still be noisy**

Detached worktree + junctioned node_modules per skill recipe; `tsc` both configs there; clean up junction before `git worktree remove --force`.

---

### Task 2: Stop the soft deadline from killing `ask_question` (E2)

**Objective:** `ask_question` is a *human-input wait*, not a stuck tool. It must not consume the 10-minute `TOOL_SOFT_DEADLINE_MS`; the run's AbortSignal remains the only thing that cancels it.

**Files:**
- Modify: `src/main/agent/executeStepTools.ts` (`raceToolDeadline` application site)
- Test: whichever existing suite pins deadline behavior (likely `tests/main/unit/agentLoopSteps.test.ts` — **verify where `raceToolDeadline`/deadline is tested before writing; read `executeStepTools.ts` fully first**)

**Step 1: Write the failing test**

```ts
it('ask_question waits for the user and is not raced by the tool soft deadline', async () => {
  // arrange a question handler that resolves after > TOOL_SOFT_DEADLINE_MS
  // (use fake timers or a small VYOTIQ_TOOL_SOFT_DEADLINE_MS override if the
  //  existing suite already does this — mirror the existing deadline test's harness)
  const res = await executeStepTools(/* ask_question step, handler resolving late */)
  expect(res.ok).toBe(true)
  expect(res.content).not.toContain('exceeded its')
})
```

**Step 2: Run it to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run <deadline test file>`
Expected: FAIL — current code races ask_question against the deadline.

**Step 3: Minimal implementation**

In the tool-execution path in `executeStepTools.ts`, exempt the blocking-question tool from `raceToolDeadline`:

```ts
/** Human-input tools wait for the user; only the run abort cancels them. */
const DEADLINE_EXEMPT_TOOLS: ReadonlySet<string> = new Set(['ask_question'])

const raced = DEADLINE_EXEMPT_TOOLS.has(name)
  ? pending
  : raceToolDeadline(pending, name, { onDeadline })
```

Keep the abort path untouched (`throwIfAborted`/AbortSignal already covers cancellation; the existing `askQuestion` handler resolves via user answer).

**Step 4: Run the deadline suite + the question suite**

Run: `node node_modules/vitest/vitest.mjs run <deadline file> tests/main/unit/askQuestion*.test.ts`
Expected: PASS — new test green, no regression in existing deadline tests (terminal must still be raced).

**Step 5: Check for coupling** — grep `src/main/agent/loopPolicy.ts` and `src/main/agent/runReceipt.ts` for the literal `exceeded its` string: the deadline message shape stays identical for non-exempt tools, so no regex coupling changes. Confirm with a grep that nothing keys on `ask_question` deadline text.

**Step 6: Commit**

```
fix(agent): let ask_question wait for the user instead of the 10-minute tool deadline
```

---

### Task 3: Coach the terminal-deadline failure toward background sessions (E3)

**Objective:** When `terminal` hits the deadline, the loop hint should point at the actual escape hatch — background sessions/polling or a narrower command — instead of the model retrying the same foreground shape.

**Files:**
- Modify: `src/main/agent/loopPolicy.ts` (`loopHintForConsecutiveToolFailures`)
- Test: `tests/main/unit/loopPolicy.test.ts` (already contains mirrored-loopHint fixtures — verified)

**Step 1: Write the failing test** (follow the file's existing literal-summary-fixture pattern):

```ts
it('coaches terminal deadline failures toward background sessions', () => {
  const hint = loopHintForConsecutiveToolFailures(2, {
    tool: 'terminal',
    summary: 'Tool "terminal" exceeded its 10-minute deadline and was stopped.'
  })
  expect(hint).toContain('background')
})
```

**Step 2: Run to verify failure** — `node node_modules/vitest/vitest.mjs run tests/main/unit/loopPolicy.test.ts` → FAIL (no branch matches).

**Step 3: Minimal branch** (insert alongside the existing edit/multi_edit branches, exact style):

```ts
} else if (recent?.tool === 'terminal' && /exceeded its .* deadline/i.test(recent.summary)) {
  lines.push(
    'terminal hit its deadline. Re-run long work as a background session and poll it, or narrow the command (single build/test target, tail the log) instead of one long foreground call.'
  )
}
```

**Step 4: Verify pass** + confirm the deadline content string in `executeStepTools.ts` still matches the regex (it does: "exceeded its N-minute deadline").

**Step 5: Commit** — `feat(agent): coach terminal deadline failures toward background sessions`

---

### Task 4: HTML preview — per-file script toggle, default off (E4)

**Objective:** Web developers previewing an agent-built page can opt in to scripts per file. Default stays exactly today's safe `sandbox=""`; opt-in is `sandbox="allow-scripts"` only — **no** `allow-same-origin`, so scripts run in an opaque origin with zero workspace access.

**Files:**
- Modify: `src/renderer/src/features/chat/components/FilePreview.tsx`
- Test: `tests/renderer/chat/filePreview.test.ts` (extend; it currently only covers `filePreviewKind.ts` helpers — the component itself is untested; add a jsdom component test, opt-in per file via `/** @vitest-environment jsdom */`)

**Step 1: Write the failing test**

```tsx
/** @vitest-environment jsdom */
// tests/renderer/chat/filePreview.sandbox.test.tsx
import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FilePreview } from '@renderer/features/chat/components/FilePreview'

describe('FilePreview html sandbox', () => {
  it('renders html without scripts by default and can enable them per file', () => {
    const { container } = render(<FilePreview path="index.html" content="<h1>hi</h1>" binary={false} />)
    const iframe = container.querySelector('iframe')!
    expect(iframe.getAttribute('sandbox')).toBe('')

    const toggle = screen.getByRole('button', { name: /enable scripts/i })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(container.querySelector('iframe')!.getAttribute('sandbox')).toBe('allow-scripts')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
  })
})
```

**Step 2: Run to verify failure** — `node node_modules/vitest/vitest.mjs run tests/renderer/chat/filePreview.sandbox.test.tsx` → FAIL (no toggle exists).

**Step 3: Minimal implementation** in `FilePreview.tsx` (self-contained; no FilesPanel wiring — FilePreview is a pure leaf):

```tsx
if (kind === 'html') {
  const [allowScripts, setAllowScripts] = useState(false)
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-file-preview="html">
      <div className="flex items-center justify-end px-2 py-1">
        <button
          type="button"
          aria-pressed={allowScripts}
          onClick={() => setAllowScripts((v) => !v)}
          className="text-caption text-muted hover:text-fg"
        >
          {allowScripts ? 'Scripts on' : 'Enable scripts'}
        </button>
      </div>
      <iframe
        title={`Preview ${path}`}
        sandbox={allowScripts ? 'allow-scripts' : ''}
        srcDoc={content}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  )
}
```

(React hooks cannot sit after an early `return` chain — lift `useState` above the kind checks; keep the button row rendered only for `kind === 'html'`.) Use existing cn/tokens; match FilesPanel icon-button styling conventions when implementing.

**Step 4: Verify pass** + rerun `tests/renderer/chat/filePreview.test.ts` (helpers untouched → still green).

**Step 5: Commit** — `feat(renderer): per-file script toggle for HTML previews (default sandboxed off)`

---

### Task 5: Agent browser can open workspace files via `file://` (E5)

**Objective:** After the agent builds a site, it (and the user, through the docked browser panel) can open `index.html` from the workspace. Scope is deliberately narrow: **only `file:` URLs whose resolved path is inside the active workspace root**. No arbitrary disk browsing.

**Files:**
- Modify: `src/main/app/browserUrl.ts` (`normalizeBrowserUrl`)
- Modify: `src/main/app/agentBrowser.ts` (`navigateUrlUnlocked` — pass the workspace root; keep `isSyncBlockedNavigation`/`assertPostNavigationPolicy`/`attachAgentSecurity` behavior unchanged)
- Tests: `tests/main/unit/agentBrowserUrl.test.ts`, `tests/main/unit/agentBrowserPolicy.test.ts`

**Step 1: Write failing tests in `agentBrowserUrl.test.ts`** (mirror its existing style):

```ts
it('accepts file: URLs inside the workspace root only', () => {
  const root = 'C:/work/demo'
  expect(normalizeBrowserUrl('file:///C:/work/demo/index.html', { workspaceRoot: root }).protocol).toBe('file:')
  expect(() => normalizeBrowserUrl('file:///C:/etc/passwd', { workspaceRoot: root })).toThrow(/inside the workspace/i)
  expect(() => normalizeBrowserUrl('file:///C:/work/demo/index.html')).toThrow(/Unsupported URL scheme/i)
  expect(() => normalizeBrowserUrl('file://./../secret.html', { workspaceRoot: root })).toThrow()
})

it('still normalizes bare domains to https', () => {
  expect(normalizeBrowserUrl('example.com', { workspaceRoot: 'C:/w' }).protocol).toBe('https:')
})
```

**Step 2: Verify failure**, then implement in `browserUrl.ts`:

```ts
export function normalizeBrowserUrl(raw: string, opts?: { workspaceRoot?: string }): URL {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('URL is required')
  const withScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(withScheme)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    if (url.protocol === 'file:' && opts?.workspaceRoot) {
      // Only files that resolve inside the workspace are ever allowed.
      const root = resolve(opts.workspaceRoot)
      const target = resolve(root, decodeURIComponent(url.pathname))
      if (target !== root && !target.startsWith(root + sep)) {
        throw new Error('file: URLs must point inside the workspace')
      }
      return url
    }
    throw new Error(`Unsupported URL scheme: ${url.protocol}`)
  }
  return url
}
```

(Use the repo's `resolveInsideWorkspace` from `src/main/workspace/safePath.ts` — already imported by `multiEdit.ts` — instead of hand-rolled prefix checks if its signature fits; that is the audited primitive.)

**Step 3: Wire `agentBrowser.ts`** — read the three `normalizeBrowserUrl` call sites first (verified: import + use inside `navigateUrlUnlocked` where `allowLocal` gating lives). Pass the workspace root from `partitionForWorkspace` context so the file scope matches the browser partition's workspace. Do not change `assertDomainAllowlist` semantics for http(s); `file:` bypasses the domain allowlist precisely because it is workspace-constrained. Post-navigation policy (`assertPostNavigationPolicy`) and sync-blocked navigation checks keep running for file: pages.

**Step 4: Policy tests** — extend `agentBrowserPolicy.test.ts`: navigate to a workspace `file:` URL resolves ok; a `file:` URL outside the workspace rejects with the workspace error before any WebContentsView navigation.

**Step 5: Renderer sanity** — `AgentBrowserPanel` sends the address-bar text through `resolveAddressBarTarget` (renderer-side, verified import). Verify with `tests/renderer/chat/agentBrowserPanel.test.tsx` that a bare `index.html` string still reaches the navigate IPC unchanged (no renderer change needed; if `resolveAddressBarTarget` rewrites unknown strings into search URLs, adjust main-side: `navigateUrl` tries `normalizeBrowserUrl`, on failure falls back to the existing search path — keep the fallback order: absolute URL → workspace file → search).

**Step 6: Commit** — `feat(browser): open workspace files via file:// in the agent browser`

---

### Task 6: End-to-end verification

**Step 1:** Full gates again after all tasks:
```
node ./node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit && node ./node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit && node ./node_modules/eslint/bin/eslint.js .
```
Expected: exit 0.

**Step 2:** Broad vitest pass per skill batching (main unit batch, shared batch, renderer per-dir batches) — never concurrent with tsc/lint.

**Step 3:** Build and probe the real app (`pnpm build` equivalent via electron-vite, then launch with a fresh `--remote-debugging-port=9xxx`):
- CDP `Runtime.evaluate` on `window.vyotiq.*`: open an HTML file preview → confirm toggle exists (DOM query `[data-file-preview="html"]`).
- Agent browser: navigate to `file://<workspace>/index.html` → state emits open url; navigate to `file://` outside workspace → error surfaces in the panel status.
- Verify fix liveness by grepping built `out/` bundles for the new identifiers (`allow-scripts` string, deadline-exempt symbol name) — bundle minifies comments away; grep identifiers/CSS, per skill rule.

**Step 4:** Kill any spawned electron; hand the app back without debug flags.

---

## Risks, tradeoffs, open questions

**Risks**
- Task 1 commits work written by a prior agent run — a hunk may be incomplete. Mitigation: Step 1 reads the full diff per subsystem before staging; the in-flight test files were already run green this session; anything found broken is fixed forward before its group's commit.
- Parallel sessions commit to main mid-session (documented 2026-08-31 incidents). Mitigation: re-check `git status` before every stage; audit `git show` for foreign hunks; never bulk-revert.
- Task 5 touches security-sensitive navigation code. The scope fence (workspace-inside only, audited `safePath` primitive, policy tests) is the mitigation; do not widen to arbitrary `file:` even if asked later without a new decision.
- Task 2 exempts exactly one tool from the deadline; if the question handler itself can hang forever on a dead IPC, the run abort path is the only escape. Acceptable: that is identical to how the run's own stop button behaves.
- Windows path shapes in Task 5 tests: cover `C:/`, `C:\\`, and URL-encoded `%20` spaces (this workspace path contains spaces) — the test list above includes the encoding case; add `\\`-style fixture when implementing.

**Tradeoffs deliberately made (bloat control)**
- No mermaid/katex markdown rendering: zero evidence in any transcript or receipt that users asked; adds dependencies against the perf rule.
- No new themes, no empty-state redesign, no diff-preview changes: verified already solid (E6).
- No new tools, no harness text changes: the deadline coaching (Task 3) is the only prompt-surface edit, and it follows the measured, mirrored-test pattern the repo already mandates.

**Open questions (ask before executing)**
1. Confirm Task 1's scope: may this session finish and commit the prior run's 38-file UX work as its own grouped commits (recommended), or does the user want to review/commit it themselves first?
2. Task 2: with the deadline exempted, an unanswered question can hold a run indefinitely until the user answers or stops it — acceptable default?
3. Task 5: is workspace-only `file:` access the agreed security fence, or should saved browser-recents also pin absolute `file:` URLs for convenience?

---

## Verification recap (acceptance criteria)

- [ ] All 38 in-flight files committed in compiling groups; committed tree typechecks in a detached worktree.
- [ ] `ask_question` survives past the previous 10-minute kill (new deadline test green).
- [ ] Terminal deadline failures produce the background-session hint (loopPolicy test green with literal fixture).
- [ ] HTML preview: default `sandbox=""` unchanged; toggle renders `allow-scripts` with `aria-pressed` state (jsdom test green).
- [ ] Agent browser: workspace `file:` navigates, outside-workspace rejects, http(s)/search behavior byte-identical (url + policy tests green).
- [ ] Full gates green: both tsc configs, eslint, vitest batches; built-app CDP probe confirms features live.
