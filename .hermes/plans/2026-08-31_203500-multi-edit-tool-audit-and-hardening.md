# multi_edit Tool — Audit Verdict + Hardening Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Close the real, evidence-verified gaps in the `multi_edit` tool (commit-phase rollback coverage, truncated-result action mislabeling, docs/schema copy) without touching any of the verified-correct wiring.

**Architecture:** `multi_edit` is a main-process atomic multi-file writer (`src/main/agent/tools/multiEdit.ts`) behind zod validation (`schemas/tools.ts`), mode/path-scope/remap gates (`tools/index.ts`, `tools/modePolicy.ts`, `tools/writeGuard.ts`), a loop-coaching + receipt-classification surface (`loopPolicy.ts`, `runReceipt.ts`), and a renderer streaming→card→turn-summary surface (`partialJson.ts` → `toolUi/parsers/edit.ts` → `EditBody`/`registry` → `turnFileDiffs.ts`). The audit found the wiring **complete and correct end-to-end**; the gaps are narrow and enumerated below with file:line receipts.

**Tech Stack:** Electron main (strict TS), Vitest (`globals: false`), zod, React 19 renderer. Windows/MSYS shell — use the exact node-direct commands in this plan, not `pnpm` (broken in this shell per `vyotiq-agent-v` skill).

---

## Part A — Audit verdict (evidence receipts, gathered 2026-08-31)

Baseline executed live this session:

```
node node_modules/vitest/vitest.mjs run tests/main/unit/editTools.test.ts tests/main/unit/toolsSchema.test.ts \
  tests/main/unit/parseToolArgs.test.ts tests/main/unit/canonicalizeToolName.test.ts tests/shared/toolSummary.test.ts \
  tests/main/unit/modePolicy.test.ts tests/main/unit/writeGuard.test.ts tests/main/unit/loopPolicy.test.ts \
  tests/main/unit/runReceipt.test.ts tests/main/unit/foldFacts.test.ts
→ Test Files 10 passed (10) | Tests 234 passed (234)

node node_modules/vitest/vitest.mjs run tests/renderer/chat/toolCardData.test.ts tests/renderer/chat/toolUi/meta.test.ts \
  tests/renderer/chat/toolUi/registry.test.ts tests/renderer/chat/toolGroup.test.tsx tests/renderer/chat/toolGroupAdapter.test.ts \
  tests/shared/partialJson.test.ts tests/shared/transcript.test.ts
→ Test Files 7 passed (7) | Tests 211 passed (211)
```

### Wiring map — verified in BOTH directions (definition → UI and back)

| Layer | Site | Status |
|---|---|---|
| Schema (args, refines, dup-path) | `src/main/agent/schemas/tools.ts:283-331` | wired; dup-path `superRefine` mirrors runtime |
| Registry blurb | `schemas/tools.ts:1038-1042` | wired ("Apply several file edits atomically…") |
| Handler | `src/main/agent/tools/index.ts:563-590` | wired; write-checkpoint priors per path, `invalidateAfterWorkspaceMutation`, summary = unique normalized paths |
| Core impl (atomic plan→temp→rename→rollback) | `src/main/agent/tools/multiEdit.ts:84-215` | wired; `withExclusiveWorkspaceMutation` wraps plan+commit (no TOCTOU) |
| Path-scope guard (inline instances) | `tools/index.ts:2209-2238` collects **every** edit path | wired |
| Plan-mode gate | `tools/modePolicy.ts:299-315` (+ set at :62-64) | wired |
| Run-artifact remap, all-or-nothing mixing rule | `tools/index.ts:2161-2188` | wired |
| Approval | `src/main/agent/toolApproval.ts:149` | wired (one approval per batch) |
| Parallel classification (serial, not batched) | `tools/classify.ts:88-91` | wired |
| Loop coaching branches | `loopPolicy.ts:214-245` (diff-hunk, dup-path, empty-args) | wired |
| Receipt failure clusters | `runReceipt.ts:91-110` | wired |
| Name canonicalization (`MultiEdit`/`multiedit`) | `schemas/tools.ts:1363-1374` compact map | wired |
| Full args kept for streaming diffs | `src/shared/domain/transcript.ts:20`, `createChatStreamController.ts:101` | wired |
| Streaming partial-JSON `edits[]` extraction | `src/shared/utils/partialJson.ts:110-217` | wired |
| Card data / counts / icon | `toolUi/parsers/edit.ts:58-96` | wired |
| Diff body + per-file header rows | `EditBody.tsx:110-112`, `parsers/edit.ts:311-325` | wired |
| Header meta ("N files", single-file icon) | `toolUi/registry.ts:256-276` | wired (pinned by `registry.test.ts:431-452`) |
| Created/Edited verb | `toolSummary.ts:53` + `inferFileWriteAction:25-43`, `meta.ts:208-210` | wired (pinned by `meta.test.ts:77-82`) |
| Turn/Session/LastTurn change summaries | `turnFileDiffs.ts:114-131, 206-211`, `parsers/edit.ts:340-359, 384-403` | wired (one defect found — Task 3) |
| Git refresh debounce | `ChatStreamLeaves.tsx:13-20` | wired |
| Docs | `landing/src/content/docs/reference/tools.md:23` | present but thin (Task 5) |

### Suspicions checked and REFUTED (do not "fix" these — they are correct)

1. **uniquePaths vs `fileCount: edits.length` mismatch** — cannot disagree: schema `superRefine` and runtime both reject duplicate paths, so counts are equal on every executable call.
2. **TOCTOU between plan-phase reads and commit-phase writes** — the *entire* plan+commit runs inside `withExclusiveWorkspaceMutation` (`multiEdit.ts:222-225`).
3. **CRLF corruption** — `applyUnifiedDiff` rejoins with the file's dominant EOL (`edit.ts:168-176`); pinned by `editTools.test.ts:64`.
4. **Path-scope bypass via multi_edit** — `index.ts:2215-2219` extracts all edit paths.
5. **Checkpoint priors recorded for files in a failed batch** — priors of unchanged files restore identical content on undo; harmless, same pattern as `edit`.
6. **Plan-artifact remap partiality** — mixing run artifacts with workspace files is rejected explicitly (`index.ts:2174-2180`).
7. **`MultiEdit` name not canonicalized** — compact-name map covers it (`multiedit` key); `TOOL_NAME_ALIASES` intentionally has no entry (compact match already resolves).

---

## Part B — Confirmed findings (ranked; each falsifiable)

**F1 (test gap, highest value).** The commit-phase rollback path — the heart of the "all-or-nothing disk" claim — has **zero test coverage**. `MultiEditDiskDeps.renameSyncFn` (`multiEdit.ts:31-44`) exists precisely to inject rename failures and no test uses it. Existing tests only cover plan-phase failure (diff mismatch). *Probe that would refute: a rename-failure injection test passing against current code.*

**F2 (real renderer defect).** `multiEditPathAction` (`parsers/edit.ts:340-359`) falls back to the **batch-wide** `inferFileWriteAction('multi_edit', content)` when a path has no per-path line in the result content. Result content is truncated for large batches (`contentTruncated`), dropping tail `- created/- wrote` lines — so tail files inherit the visible prefix's action and the Changes panel mislabels `created`↔`modified`. *Probe: feed a truncated content row without the path's line and observe the inherited action.*

**F3 (test gap).** `toolMultiEdit` block in `editTools.test.ts:148-187` lacks: empty-contents guard (reject overwrite-of-non-empty / allow create-empty), binary-extension guard, abort-signal mid-batch. The `edit` tool has guard tests (`editTools.test.ts:95-104`); `multi_edit` parity is missing.

**F4 (docs gap).** `tools.md:23` is a one-liner; the contents-vs-diff contract and one-entry-per-path rule are undocumented on the landing reference.

**F5 (schema copy inconsistency).** `schemas/tools.ts:292` describes contents as "Full **non-empty** file contents" but empty contents is legal and used to **create** an empty file (runtime guard only rejects emptying a non-empty existing file, `multiEdit.ts:114-119`). Description can steer the model away from a legal, useful call.

**F6 (gating measurement required before any change).** The harness (`resources/harness/default.md`) has **zero** multi_edit guidance (grep: 0 matches). Per the repo standard (delegation precedent: a prompting gap looked like dead wiring; and "no speculative bloat — measure first"), this is a **measurement task, not a fix**: quantify usage/failure clusters from `%APPDATA%/vyotiq` receipts before deciding whether a harness line is warranted.

**F7 (minor test gap).** No renderer component test renders the multi-file diff card (per-file header rows + gap separators); only parsers are covered. Nice-to-have characterization test.

---

## Part C — Tasks

Global notes for the executor:
- Vitest `globals: false` — import `describe/it/expect` from `'vitest'`.
- Never bulk-revert the working tree; stage exact paths only. Sibling sessions commit mid-session — re-check `git status` before each stage and audit `git show <c> -- <file>` for foreign hunks after committing shared files.
- Do not touch anything in the AGENTS.md removed-UI list (none of it intersects multi_edit).
- Foreground `terminal` cap is 600s; gates below are all well under it. Never run a second gate while a vitest batch runs (CPU contention produces phantom failures).

### Task 1: Commit-phase rollback regression tests (F1)

**Objective:** Prove and pin that a mid-commit rename failure leaves the workspace byte-identical and drops no stray `.bak`/`.tmp` files.

**Files:**
- Modify: `tests/main/unit/editTools.test.ts` (inside `describe('toolMultiEdit', …)`, after line 187)
- Production code: **none expected** — these are characterization tests of `multiEdit.ts:176-209`

**Step 1: Write the tests** (append inside the `toolMultiEdit` describe):

```ts
  it('rolls back earlier files when a later commit rename fails mid-batch', () => {
    writeFileSync(join(workspace, 'a.txt'), 'a\n', 'utf8')
    writeFileSync(join(workspace, 'b.txt'), 'b\n', 'utf8')
    const realRename = renameSync
    const disk: MultiEditDiskDeps = {
      renameSyncFn: (from, to) => {
        // Fail exactly the b.txt → b.txt.<pid>.<hex>.bak backup move.
        if (String(from).endsWith('b.txt')) throw new Error('EACCES injected mid-commit')
        realRename(String(from), String(to))
      }
    }
    expect(() =>
      toolMultiEdit(
        workspace,
        [
          { path: 'a.txt', contents: 'A\n' },
          { path: 'b.txt', contents: 'B\n' }
        ],
        undefined,
        disk
      )
    ).toThrow(/EACCES injected mid-commit/)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('a\n')
    expect(readFileSync(join(workspace, 'b.txt'), 'utf8')).toBe('b\n')
    const strays = readdirSync(workspace).filter((f) => f.endsWith('.bak') || f.endsWith('.tmp'))
    expect(strays).toEqual([])
  })

  it('aborts cleanly when the signal fires before commit and writes nothing', () => {
    const controller = new AbortController()
    controller.abort()
    expect(() =>
      toolMultiEdit(
        workspace,
        [
          { path: 'x.txt', contents: 'x\n' },
          { path: 'y.txt', contents: 'y\n' }
        ],
        controller.signal
      )
    ).toThrow()
    expect(existsSync(join(workspace, 'x.txt'))).toBe(false)
    expect(existsSync(join(workspace, 'y.txt'))).toBe(false)
  })
```

Imports to add at the top of the file (merge with existing): `readdirSync`, `renameSync` from `'fs'`; `AbortController` is global (Node 22). `MultiEditDiskDeps` from `'@main/agent/tools/multiEdit'` (extend the existing type import at line 27).

**Step 2: Run**

Run: `node node_modules/vitest/vitest.mjs run tests/main/unit/editTools.test.ts`
Expected: **PASS** (40 → 42 tests). If a rollback test FAILS, that is a *real* defect in `multiEdit.ts:176-209` — fix the production rollback (one fix per defect, minimal), then re-run. Do not weaken the test.

**Step 3: Commit**

```
git add tests/main/unit/editTools.test.ts
git commit -m "test(multi_edit): pin commit-phase rollback and abort-signal atomicity"
```

### Task 2: Guard parity tests — empty contents + binary path (F3)

**Objective:** Pin multi_edit's empty-contents and binary-extension guards to the exact semantics the runtime implements (and the `edit` tool already pins).

**Files:**
- Modify: `tests/main/unit/editTools.test.ts` (same describe block)

**Step 1: Write the tests**

```ts
  it('refuses to replace a non-empty file with empty contents', () => {
    writeFileSync(join(workspace, 'full.txt'), 'data\n', 'utf8')
    expect(() =>
      toolMultiEdit(workspace, [{ path: 'full.txt', contents: '' }])
    ).toThrow(/refusing to replace a non-empty file with empty contents/)
    expect(readFileSync(join(workspace, 'full.txt'), 'utf8')).toBe('data\n')
  })

  it('allows creating a new empty file', () => {
    const out = toolMultiEdit(workspace, [{ path: 'empty.txt', contents: '' }])
    expect(out).toMatch(/Applied 1 edit:\n- created empty\.txt/)
    expect(readFileSync(join(workspace, 'empty.txt'), 'utf8')).toBe('')
  })

  it('refuses text contents to a binary extension path', () => {
    expect(() =>
      toolMultiEdit(workspace, [{ path: 'model.gguf', contents: 'text' }])
    ).toThrow(/binary/)
    expect(existsSync(join(workspace, 'model.gguf'))).toBe(false)
  })
```

**Step 2: Run** — same command as Task 1. Expected: **PASS** (42 → 45 tests). The guards live at `multiEdit.ts:114-119` and `writeGuard.ts:23-30`; a failure here means semantics drifted from `edit` — reconcile toward the `edit` behavior (fix forward).

**Step 3: Commit**

```
git add tests/main/unit/editTools.test.ts
git commit -m "test(multi_edit): pin empty-contents and binary-path guard parity with edit"
```

### Task 3: Fix truncated-result action mislabeling (F2 — the one code fix)

**Objective:** A multi_edit path whose `- created/- wrote` line was cut by result-content truncation must not inherit the batch-wide action from the visible prefix.

**Files:**
- Modify: `src/renderer/src/features/chat/toolUi/parsers/edit.ts:340-359` and its call site at :394
- Test: `tests/renderer/chat/toolCardData.test.ts` (locate the existing `collectWritingChanges` block with `grep -n "collectWritingChanges" tests/renderer/chat/toolCardData.test.ts` first; add next to it)

**Step 1: Write the failing test** (in `toolCardData.test.ts`)

```ts
  it('does not inherit a batch-wide write action for paths lost to content truncation', () => {
    const tool: UiToolRow = {
      id: 'me1',
      name: 'multi_edit',
      status: 'done',
      summary: 'a.ts, b.ts',
      content: 'Applied 2 edits:\n- created src/a.ts\n- wrote src/b.ts',
      contentTruncated: true,
      argsPreview: JSON.stringify({
        edits: [
          { path: 'src/a.ts', contents: 'A\n' },
          { path: 'src/b.ts', contents: 'B\n' }
        ]
      })
    } as UiToolRow
    const changes = collectWritingChanges(tool)
    const a = changes.find((c) => c.path === 'src/a.ts')
    const b = changes.find((c) => c.path === 'src/b.ts')
    expect(a?.action).toBe('created') // line still visible in truncated prefix
    expect(b?.action).toBeUndefined() // line cut — must NOT inherit 'modified'
  })
```

(Adapt the `UiToolRow` literal to the helpers the file already uses for building rows; keep `contentTruncated: true` as the differentiator. Also keep/verify the untruncated twin still expects `b.action === 'modified'`.)

**Step 2: Run to verify failure**

Run: `node node_modules/vitest/vitest.mjs run tests/renderer/chat/toolCardData.test.ts`
Expected: **FAIL** — `b.action` is `'modified'` (inherited from the prefix fallback), proving the defect.

**Step 3: Minimal fix** in `parsers/edit.ts` — change the function to take the row (it already imports the type) and guard only the *fallback*, never the per-line lookup:

```ts
function multiEditPathAction(
  tool: UiToolRow,
  path: string
): 'created' | 'modified' | undefined {
  const content = tool.content
  if (!content) return undefined
  const needle = normalizeWritePath(path)
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('- ')) continue
    const rest = line.slice(2)
    const space = rest.indexOf(' ')
    if (space < 0) continue
    const verb = rest.slice(0, space).toLowerCase()
    const linePath = normalizeWritePath(rest.slice(space + 1).trim())
    if (linePath !== needle) continue
    if (verb === 'created') return 'created'
    if (verb === 'wrote' || verb === 'patched') return 'modified'
  }
  // Truncated result content drops tail lines; a path whose entry was cut must
  // not inherit the visible prefix's batch-wide action.
  if (tool.contentTruncated) return undefined
  return inferFileWriteAction('multi_edit', content) ?? undefined
}
```

Call site (:394) becomes:

```ts
      const change = changeFromEditArgs(record, multiEditPathAction(tool, path))
```

**Step 4: Run to verify pass** — same command. Expected: **PASS** (34 tests). Then run the adjacent batch: `node node_modules/vitest/vitest.mjs run tests/renderer/chat/toolCardData.test.ts tests/renderer/chat/toolUi/meta.test.ts tests/renderer/chat/toolGroup.test.tsx` — expected all green (turn-summary consumers).

**Step 5: Commit**

```
git add src/renderer/src/features/chat/toolUi/parsers/edit.ts tests/renderer/chat/toolCardData.test.ts
git commit -m "fix(chat): stop truncated multi_edit results mislabeling per-file write actions"
```

### Task 4: Multi-file diff card characterization test (F7)

**Objective:** Pin that the streaming/done card renders one header row per edit path with gap separators.

**Files:**
- Create: `tests/renderer/chat/toolUi/editBody.multiFile.test.tsx` (must start with `/** @vitest-environment jsdom */`)

**Step 1: Write the test** — render `MultiEditBody` (from `@renderer/features/chat/toolUi/bodies/EditBody`) with a done row whose `argsPreview` is `JSON.stringify({ edits: [{ path: 'src/a.ts', contents: 'A\n' }, { path: 'src/b.ts', diff: '@@ -1 +1 @@\n-old\n+new\n' }] })`; assert via Testing Library that both path header rows (`src/a.ts`, `src/b.ts`) and the `new` diff line are present. Build the row shape by copying an existing done-row fixture from `tests/renderer/chat/toolUi/registry.test.ts:431-452`. If the preload bridge is touched by imports, fake `window.vyotiq` the standard way.

**Step 2: Run**

Run: `node node_modules/vitest/vitest.mjs run tests/renderer/chat/toolUi/editBody.multiFile.test.tsx`
Expected: **PASS**. If it exposes a rendering defect (e.g. a path header dropped when an edit has no diff chunk — see `parsers/edit.ts:313-317`), that is a genuine finding: fix minimally in `parseDiffPreview` and keep both assertions.

**Step 3: Commit**

```
git add tests/renderer/chat/toolUi/editBody.multiFile.test.tsx
git commit -m "test(chat): pin multi_edit card renders one diff section per file"
```

### Task 5: Landing docs contract line (F4)

**Objective:** Document the multi_edit contract on the tools reference.

**Files:**
- Modify: `landing/src/content/docs/reference/tools.md:23`

**Step 1:** Read `tests/landing/docsTruth.test.ts` first to learn what it pins about this file (format/wording constraints). Then replace line 23 with:

```markdown
- `multi_edit` — several file edits applied atomically (full `contents` or a unified `diff` per entry; one entry per path; if any edit fails, nothing is written)
```

**Step 2: Run**

Run: `node node_modules/vitest/vitest.mjs run tests/landing/docsTruth.test.ts`
Expected: **PASS**. Adjust wording within the documented contract if the truth-test pins a format.

**Step 3: Commit**

```
git add landing/src/content/docs/reference/tools.md
git commit -m "docs(landing): document multi_edit atomicity and contents/diff contract"
```

### Task 6: Schema description wording (F5)

**Objective:** Stop telling the model contents must be non-empty when empty contents legally creates an empty file.

**Files:**
- Modify: `src/main/agent/schemas/tools.ts:290-293`

**Step 1:** Grep for pinned copies first: `grep -rn "non-empty file contents" tests/ src/` — if `tests/main/unit/toolsSchema.test.ts` (or any registry-parity pin) asserts the old string, update the pin in the same commit.

**Step 2:** Change the description to:

```ts
            contents: z
              .string()
              .describe('Full file contents to write (empty contents is allowed only when creating a new file); use diff to empty an existing file')
              .optional(),
```

**Step 3: Run**

Run: `node node_modules/vitest/vitest.mjs run tests/main/unit/toolsSchema.test.ts tests/main/unit/parseToolArgs.test.ts`
Expected: **PASS** (43 + 25).

**Step 4: Commit**

```
git add src/main/agent/schemas/tools.ts tests/main/unit/toolsSchema.test.ts
git commit -m "fix(tools): correct multi_edit contents description (empty contents valid for new files)"
```

### Task 7: Harness coverage measurement — decide with data, then act or stand down (F6)

**Objective:** Quantify whether multi_edit needs harness guidance. **No code changes in this task unless the data demands it.**

**Files:**
- Create: `.hermes/plans/2026-08-31-multi-edit-harness-evidence.md` (the evidence note; the only deliverable)

**Step 1:** Scan transcripts with **pure Python** (MSYS `grep $(find …)` silently returns nothing on paths with spaces — repo skill warning). Read `%APPDATA%/vyotiq/sessions/*/messages.jsonl` (+ `events.jsonl` failure clusters / runReceipt data): count per run (a) multi_edit invocations, (b) multi_edit failures by cluster (reuse `runReceipt.ts` cluster regexes: `Diff hunk failed to match`, `duplicate path`, `empty arguments`, `edits requires`), (c) turns where ≥2 workspace files were written by *sequential separate* `edit`/`str_replace` calls (atomic-batch candidates), (d) multi_edit calls that mixed `contents` and `diff` or repeated a path.

**Step 2:** Decision rule (write the verdict in the note):
- If (c) is a meaningful share of multi-file turns **and** the writes were order-independent (no read-between-writes dependency), draft ONE harness `tool_policy` line (e.g. "prefer multi_edit for multi-file edits"), ground it in the measured numbers, and land it with a `harnessProbeDelivery`-style vitest probe asserting the text reaches the `tool_policy` section of the real `loadHarness()` (pattern: `tests/main/unit/harnessProbeDelivery.test.ts`). Gate: `node node_modules/vitest/vitest.mjs run tests/main/unit/harness.test.ts tests/main/unit/harnessProbeDelivery.test.ts`.
- If failures in (b) are already covered by the `loopPolicy` coaching branches (`loopPolicy.ts:214-245`) and usage is healthy, record **"no harness change — data shows no pathology"** and stop. The user's standing standard forbids speculative prompt bloat.

**Step 3:** Commit (only if a harness line landed; the evidence note alone ships untracked or in the same docs commit as Task 5 if the user wants it kept).

### Task 8: Full verification gates

**Objective:** Prove nothing regressed, in the repo's real gate order.

Run (background, notify, then `process wait`; see skill for the >10-min rule):

```
node ./node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit && node ./node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit
node ./node_modules/eslint/bin/eslint.js .
node node_modules/vitest/vitest.mjs run tests/main/unit
node node_modules/vitest/vitest.mjs run tests/shared
node node_modules/vitest/vitest.mjs run tests/main/e2e
node node_modules/vitest/vitest.mjs run tests/renderer/chat/toolCardData.test.ts tests/renderer/chat/toolUi tests/renderer/chat/toolGroup.test.tsx tests/renderer/chat/toolGroupAdapter.test.ts
```

Expected: tsc both configs 0 errors; eslint 0 problems; all suites green. Report exact pass/fail counts per suite. If any failure appears: `git stash push -m audit-verify -- <changed files>` → rerun → `git stash pop` to attribute pre-existing vs regression before touching anything (renderer/chat full-dir batches can hang in this environment — keep per-file/per-dir batches as listed).

---

## Part D — Risks, tradeoffs, open questions

**Risks**
- Task 3 touches a shared parser file — sibling sessions may hold in-flight edits there; verify foreign hunks after commit (`vyotiq-agent-v` skill rule).
- Task 6 changes a tool description that registry-parity tests may pin; the grep-first step is mandatory.
- The Task 1 rollback tests depend on injected-rename call ordering; if ordering drifts (e.g. backup strategy changes), update the injection to a destination-pattern predicate, not a call counter (the pattern form above is already order-tolerant except for the `endsWith('b.txt')` backup move — keep that invariant commented in the test).

**Tradeoffs accepted**
- Empty-contents-create-empty-file stays allowed (schema + runtime agree); only the *description* is corrected — no behavior gate added (YAGNI).
- Harness change is deliberately gated on measured transcript data, not added speculatively.

**Open questions for the user**
1. Should the evidence note from Task 7 be committed or stay session-local?
2. If Task 7's data shows multi_edit under-selection, do you want the harness line this pass, or a separate run?

**Deliverable recap:** F1/F3/F7 → regression+characterization tests (Tasks 1, 2, 4); F2 → one minimal renderer fix with TDD (Task 3); F4/F5 → copy fixes (Tasks 5, 6); F6 → data-gated decision (Task 7); full gates (Task 8). Everything else in the multi_edit surface is verified wired end-to-end and must not be touched.
