# Prompt-Cache Fix for OpenCode Go Chat Transport — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make prompt caching actually engage on the OpenCode Go chat-completions transport (the path used by `glm-5.3-flash`), verified by live run telemetry — not by claimed numbers.

**Architecture:** One-line wiring fix at the provider factory (`enablePromptCache: true`), TDD-pinned at the request-body level, then verified end-to-end against the real app: rebuild, run a live multi-step session, and confirm `step_usage` events report non-zero `cachedInputTokens` on steps ≥ 2. Accounting and UI layers were audited and are honest — they are NOT touched (see Findings).

**Tech Stack:** Electron main process, TypeScript strict, Vitest (`globals: false`), OpenAI-compatible wire (`prompt_cache_key`).

---

## Audit verdict (evidence-based, measured 2026-08-31 from `%APPDATA%/vyotiq`)

### What is REAL and was verified working (do not touch)

| Layer | Evidence |
|---|---|
| Provider cache-field parsing | `anthropic.ts` `applyUsage` keeps `cache_read/cache_creation_input_tokens` in separate buckets (`inputTokensIncludesCache: false`); `openai.ts` `parseOpenAiCompatUsage` reads `prompt_tokens_details.cached_tokens` + `prompt_cache_hit_tokens`; `openaiResponses.ts` reads `input_tokens_details.cached_tokens`; `geminiInteractions.ts` reads 6 cached-field variants. |
| Telemetry sums | `runTelemetry.ts` `mergeStepUsageTotals` / `stepUsageTotalsFromPersistedEvents` — recompute from raw `step_usage` events matched the persisted receipt byte-for-byte (run 73aa7ce8: `billedInputTokens` 626,524 = Σ events; `billedCachedInputTokens` 23,808 = Σ events). |
| UI honesty | `messageFooterStats.ts` renders `N% cache hit` ONLY when `stepsWithCacheReport > 0 && billedCachedInputTokens > 0`; `$` only when `stepsWithCostReport === steps`. No fake numbers possible from this code. |
| Data sanity | 195 `step_usage` rows across 14 runs: **0** rows with `cachedInputTokens > inputTokens`. The displayed percentages are real provider-reported data. |
| Anthropic breakpoints | tools → system → messages order + last-tool breakpoint (`anthropic.ts:165-178`) is the documented-correct cache order; stable/volatile split keeps volatile OUT of the cached prefix. |
| Loop wiring | `loop.ts:2320` passes `promptCacheKey: runId` on every step, incl. compaction fork (`compactRun.ts:334`). |
| Low-cache tripwire | `evaluateTokenCostWarnings` (`low_cache_hit_rate`, rolling 5-step mean < 0.1 on ≥20k-input steps) fired in production (3 `token_cost_hint` events on disk). |

### What is BROKEN — root cause, proven

**The OpenCode Go chat transport drops `prompt_cache_key`.**

- `src/main/agent/providers/opencode.ts:25-27` — `opencodeChat = createOpenAiCompatibleProvider('opencode', { defaultBaseUrl: OPENCODE_GO_BASE })` — **no `enablePromptCache: true`**.
- `src/main/agent/providers/openai.ts:1212` — `prompt_cache_key` is gated on `opts.enablePromptCache && req.promptCacheKey`. Without the flag the loop's key is **silently discarded**.
- `src/shared/domain/opencodeGoCatalog.ts:198-204` — `glm-5.3-flash` is in neither `RESPONSES_MODELS` nor `MESSAGES_MODELS` → transport `chat` → this is the exact path every current run takes.
- The same provider's other transports DO send cache keys (`openaiResponses.ts:320` sends `prompt_cache_key`; `anthropic.ts` sends native `cache_control`) — the chat path is the inconsistent one.
- `custom` provider ships `enablePromptCache: true` with the comment "Hosts that ignore unknown fields still benefit when OpenAI-like" (`openai.ts:1763-1764`) — the same reasoning applies to the OpenCode gateway, which demonstrably honors cache (see below).

**Measured impact (live telemetry, all `opencode` / `glm-5.3-flash`):**

| Run | Steps | Σ input tok | Σ cached tok | Overall hit | Pattern |
|---|---|---|---|---|---|
| 73aa7ce8 | 11 | 626,524 | 23,808 | **3.8%** | 5-step zero streak (8–12) |
| d8d9ef8d | 17 | 731,197 | 65,664 | **9.0%** | 4+ step zero streaks |
| d07ae5fe | 62 | 5,281,884 | 211,520 | **4.0%** | 0% at 280–310k tok/step |
| 82889e99 | 31 | 5,323,293 | 539,328 | 10.1% | alternates 100% / 0% (146=0,147=100%,148–150=0) |
| 72d5df60 | 60 | 9,890,720 | 7,347,968 | 74.3% | 1–5-step zero streaks interleaved with 95–100% hits |

**Ruled out (with evidence):**
- **TTL expiry** — median inter-step gap 60–109s vs 5-min cache TTL; step 6 of 72d5df60 HIT after a 297s gap while step 7 MISSED after 176s. Time-independent.
- **Prefix busting as primary cause** — hits that occur are 95–100% of input; misses are binary 0%. A prefix mutation would show partial hits collapsing; instead steps bounce between full-hit and full-miss on identical prefixes.
- **Fake accounting** — the gateway itself reports `prompt_tokens_details.cached_tokens` (including explicit 0s on misses; `cacheReported: true` with `cached: 0` rows exist), so both the hits and the misses are provider-reported truth.

**Diagnosis:** the OpenCode Go gateway fans out to upstream cache shards; without a stable `prompt_cache_key` consecutive steps of one run land on different replicas → binary 0% despite byte-identical prefixes. When they happen to land on the warm shard, hits are near-100%. Sending `prompt_cache_key: runId` (already produced by the loop) gives the gateway the affinity hint it needs — exactly the mechanism OpenAI documents for cache routing and that the codebase already trusts for `openai`, `openrouter`, and `custom`.

**Cost of the bug:** ≈10.9M fresh-input tokens across just the four worst runs above were billed at full input price that should have been cache reads. (No invented USD: these runs carry no `billedCost` field — savings are stated in tokens, USD only when the gateway reports it.)

---

## Proposed approach

1. Flip the flag on the OpenCode Go chat factory (`enablePromptCache: true`), exported as a named opts constant so the wiring itself is test-pinnable.
2. TDD: failing test first (`prompt_cache_key` absent today for `opencode`), then the one-line fix, then wiring-pin tests for all three transports.
3. Optional-guard ONLY if the live probe shows the gateway rejecting the field: extend the existing 4-attempt retry loop's `bodyOverrides` with `omitCacheKey` (mirror of `omitIncludeUsage`, `httpErrors.ts` pattern). Do NOT build this speculatively (YAGNI) — gate on probe evidence.
4. Rebuild the app and verify on a REAL run: `step_usage` events with non-zero `cachedInputTokens` on steps ≥ 2, and re-measure the hit-rate table above for the after-state.

---

## Step-by-step plan

### Task 1: Write the failing test (RED)

**Objective:** Prove `prompt_cache_key` is dropped on the opencode chat path today.

**Files:**
- Modify: `tests/main/unit/openaiStreamOptions.test.ts` (new `describe` block; imports `describe/it/expect` from `'vitest'` — `globals: false`)

**Step 1: Add the failing test**

```ts
import { buildOpenAiCompatBody } from '../../../src/main/agent/providers/openai'
// (import already exists in the file — extend, don't duplicate)

describe('opencode chat transport prompt-cache wiring', () => {
  const baseReq = {
    model: 'glm-5.3-flash',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    signal: new AbortController().signal,
    promptCacheKey: 'run-xyz'
  }

  it('sends prompt_cache_key for opencode chat models (cache affinity)', () => {
    const body = buildOpenAiCompatBody(
      { ...baseReq } as never,
      { defaultBaseUrl: 'https://opencode.ai/zen/go/v1', enablePromptCache: true },
      'opencode'
    )
    expect(body.prompt_cache_key).toBe('run-xyz')
  })
})
```

Note: the test above passes already against the body builder with `enablePromptCache: true`. The FAILING assertion is the wiring pin in Task 2 — so Task 1's real red test is:

```ts
// tests/main/unit/opencodeProvider.test.ts — append inside the existing describe
it('chat factory sends prompt_cache_key (enablePromptCache wired)', () => {
  const { OPENCODE_CHAT_OPTS } = await import('@main/agent/providers/opencode') // see Task 2 export
  expect(OPENCODE_CHAT_OPTS.enablePromptCache).toBe(true)
  const body = buildOpenAiCompatBody(
    { model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }], tools: [], signal: new AbortController().signal, promptCacheKey: 'run-xyz' } as never,
    OPENCODE_CHAT_OPTS,
    'opencode'
  )
  expect(body.prompt_cache_key).toBe('run-xyz')
})
```

**Step 2: Run to verify failure**

Run: `node node_modules/vitest/vitest.mjs run tests/main/unit/opencodeProvider.test.ts`
Expected: FAIL — `OPENCODE_CHAT_OPTS` is not exported / `enablePromptCache` undefined (this is the proof the wiring is absent).

### Task 2: The fix (GREEN)

**Objective:** Send `prompt_cache_key` on the OpenCode Go chat transport.

**Files:**
- Modify: `src/main/agent/providers/opencode.ts:25-27`

**Step 1: Minimal implementation**

```ts
/** Chat-completions transport opts. enablePromptCache sends prompt_cache_key (stable per runId)
 *  so the gateway keeps cache affinity across steps — without it live runs bounce between
 *  cache shards (measured 2026-08-31: 3.8–10% overall hit rate, binary 0%/100% alternation). */
export const OPENCODE_CHAT_OPTS = {
  defaultBaseUrl: OPENCODE_GO_BASE,
  enablePromptCache: true
} as const

const opencodeChat = createOpenAiCompatibleProvider('opencode', OPENCODE_CHAT_OPTS)
```

**Step 2: Run the test to verify pass**

Run: `node node_modules/vitest/vitest.mjs run tests/main/unit/opencodeProvider.test.ts tests/main/unit/openaiStreamOptions.test.ts`
Expected: PASS (all existing cases in `openaiStreamOptions.test.ts` must stay green — the groq/deepseek omission pins are intentional and unaffected).

**Step 3: Commit**

```
git add src/main/agent/providers/opencode.ts tests/main/unit/opencodeProvider.test.ts
git commit -m "fix(providers): send prompt_cache_key on OpenCode Go chat transport"
```

Body bullets: the measured 3.8–10% hit-rate table; why TTL/prefix-bust were ruled out; flag parity with `custom`/`openrouter`.

### Task 3: Regression-pin the other two transports (they already work)

**Objective:** Lock the responses + messages cache-key behavior so a future refactor can't silently drop it (the bug class just fixed).

**Files:**
- Test: `tests/main/unit/opencodeProvider.test.ts` (append)

**Step 1: Pin responses + messages wiring**

```ts
// Responses transport: streamOpenAiResponses already includes req.promptCacheKey (openaiResponses.ts:320).
// Pin via exported builder behavior — assert the body carries the key (uses a fetch-stub probe
// OR the exported body assembly; prefer executing the real streamOpenAiResponses with vi.stubGlobal('fetch')).
it('responses transport sends prompt_cache_key', async () => {
  // vi.stubGlobal('fetch', ...) returning a minimal SSE 200; drive streamOpenAiResponses
  // with req.promptCacheKey='run-xyz', capture the request body from the fetch args,
  // expect body.prompt_cache_key === 'run-xyz'
})
// Messages transport: buildAnthropicBody already marks tools+system+history with cache_control.
// Pin: last tool def + stable system + last history block carry cache_control (behavior statement,
// no PROBE wording).
```

**Step 2: Run** — `node node_modules/vitest/vitest.mjs run tests/main/unit/opencodeProvider.test.ts` → PASS.

**Step 3: Commit** — `git commit -m "test(providers): pin cache-key/cache-control wiring across opencode transports"`

### Task 4: Live end-to-end verification (the "not fake" proof)

**Objective:** Demonstrate the fix produces real cache hits in the running app, not just unit tests.

**Files:** none changed (verification only). Artifacts: measured before/after table appended to this plan file or the commit body.

**Step 1: Rebuild the real bundle** (source fixes do NOT reach `pnpm start` — it serves `out/`):

Run: `pnpm build` (or MSYS-safe: `node ./node_modules/electron-vite/bin/electron-vite.js build` after the sync scripts `pnpm build` normally chains). Verify fix liveness after build:
`grep -c "prompt_cache_key" out/main/index.js` (minified — expect ≥1) — per repo runbook, identifiers survive minification.

**Step 2: Launch with a fresh CDP port** (`--remote-debugging-port=9xxx` — never reuse a stale port; `Cannot start http server for devtools` means silent CDP death) and drive the real preload bridge (`window.vyotiq.*` via `Runtime.evaluate`, check `raw.exceptionDetails` before reading values). Start a small 4–6-step agent task on provider `opencode`, model `glm-5.3-flash`.

**Step 3: Read the real telemetry** — `%APPDATA%/vyotiq/workspaces/<ws>/sessions/<runId>/events.jsonl`, rows `type == "step_usage"`:

Acceptance criteria (ALL must hold):
- `steps >= 4`
- At least one step ≥ 2 has `cachedInputTokens > 0` with `cacheReported: true`
- Zero-streak pattern (≥3 consecutive 0%-steps at ≥20k input) ABSENT in the probe run
- Overall run hit rate (Σcached / Σinput) materially above the 3.8–10% baseline band; report the actual number
- Byte-check honesty: no row with `cachedInputTokens > inputTokens`

**Step 4: If (and only if) the gateway rejects the field** — a step fails with HTTP 400 naming `prompt_cache_key`: implement `omitCacheKey` retry in the existing 4-attempt loop (`src/main/agent/providers/openai.ts` `bodyOverrides`, mirroring `shouldRetryOmitIncludeUsage` in `httpErrors.ts`), with a mirrored unit test. Evidence gate: no 400 observed → do not build.

**Step 5: Commit verification evidence** — `git commit -m "docs(audit): measured post-fix cache hit rates"` (if evidence is committed) or report in-chat.

### Task 5: Full gates (before declaring done)

Run (MSYS-safe invocations, no concurrent gates — CPU contention wedges renderer tests):
1. `node ./node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit && node ./node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit`
2. `node node_modules/vitest/vitest.mjs run tests/main/unit/opencodeProvider.test.ts tests/main/unit/openaiStreamOptions.test.ts tests/main/unit/providerStreams.test.ts tests/main/unit/openaiOllamaCloud.test.ts`
3. `node ./node_modules/eslint/bin/eslint.js src/main/agent/providers/opencode.ts tests/main/unit/opencodeProvider.test.ts`

Expected: all green; report exact pass counts.

---

## Files likely to change

| File | Change |
|---|---|
| `src/main/agent/providers/opencode.ts` | +`enablePromptCache: true` via exported `OPENCODE_CHAT_OPTS` (the entire production diff) |
| `tests/main/unit/opencodeProvider.test.ts` | wiring-pin test(s) |
| `tests/main/unit/openaiStreamOptions.test.ts` | optional opencode body assertion |
| `src/main/agent/providers/openai.ts` | ONLY IF Task 4 Step 4 gate fires: `omitCacheKey` retry |

**Explicitly NOT changed (audited correct):** `runTelemetry.ts`, `tokenCost.ts`, `messageFooterStats.ts`, `ContextMeter.tsx`, `runReceipt.ts`, `anthropic.ts`, `systemZones.ts`, `assemble.ts`, `estimate.ts`.

## Risks / tradeoffs / open questions

- **Gateway rejects the unknown field (low):** the same field already ships to `openrouter` and `custom` OpenAI-like hosts without issue; the OpenCode gateway's Responses endpoint already receives `prompt_cache_key` from this app (`openaiResponses.ts:320`) without 400s in any captured run. Task 4 Step 4 is the safety net.
- **No behavioral change if the gateway ignores the key:** worst case = status quo (misses continue). The field is inert for hosts that ignore unknown params — the `custom` provider precedent.
- **Savings in USD cannot be stated** without the gateway's price list; `billedCost` is only summed when the provider reports it (`stepsWithCostReport` gate). Report token deltas; never fabricate prices (repo rule: live-catalog data resolves at runtime; no hardcoded numbers).
- **Open question (for the user, not blocking):** should `xai`/`groq`/`mistral` also get `enablePromptCache: true`? No live evidence of harm or benefit on those hosts in the captured runs — left out (YAGNI, evidence-based).
- **Windows dev gotchas in force:** clear `ELECTRON_RUN_AS_NODE` before launches; fresh CDP port per launch; `tasklist | grep -ci electron` after destructive probes; orphaned `electron.exe` holds the Vite port after killed dev shells.

## Verification checklist (definition of done)

- [x] RED→GREEN test for `OPENCODE_CHAT_OPTS.enablePromptCache === true` and `body.prompt_cache_key` present
- [x] Existing `openaiStreamOptions.test.ts` pins (groq/deepseek omission) still green
- [x] Responses + messages transport cache wiring regression-pinned
- [x] `out/main/index.js` contains the fix (bundle grep: `OPENCODE_CHAT_OPTS` with `enablePromptCache: true`)
- [x] Live probe run: ≥4 steps, non-zero `cachedInputTokens` on steps ≥ 2, no ≥3-step zero streak, hit rate reported from real events
- [x] tsc (both configs) + targeted vitest (121/121) + eslint green

---

## Execution addendum (2026-08-31, commit 33dde67)

## Per-provider completion (2026-08-31, commit af051d4)

Full sweep of all 11 providers against their official cache contracts. Two additional real gaps found and fixed:

- **Mistral** (`af051d4`): `prompt_cache_key` is officially documented (docs.mistral.ai, cached tokens at 10% of input price, reported in `prompt_tokens_details.cached_tokens`) — was unsent. Wired via exported `MISTRAL_OPTS { enablePromptCache: true }`.
- **xAI** (`af051d4`): official docs direct Chat Completions cache affinity through the `x-grok-conv-id` header ("Always set … maximizing cache hits"); `prompt_cache_key` is Responses-API-only. Wired via exported `XAI_OPTS { convIdHeader: true }` — the chat transport now stamps the header from the run's promptCacheKey; chat bodies correctly carry no body key.
- **Verified automatic (no field exists, correctly omitted and test-pinned):** Groq, DeepSeek. **Already correct:** OpenAI/OpenRouter/Custom/opencode-chat (33dde67), Gemini generateContent (implicit caching, stable-system + trailing-volatile zones), Gemini Interactions (`previous_interaction_id` stateful continuation), Anthropic (native cache_control breakpoints), opencode Responses/Messages transports.
- Gates: 154/154 provider-suite tests (incl. new wiring pins + x-grok-conv-id header assertion against stubbed fetch on the real xaiProvider stream path), tsc node+web, eslint. Worktree HEAD build booted; live probe run `5d827021`: **59.3% overall cache hit, zero cold streaks** (step 1 even resumed the gateway's still-warm 99.8% prefix). All provider-reported, `cached ≤ input` verified.


Executed inline (Tasks 1–3 share files; subagent-driven-development routes same-file batches inline).

- **Shipped:** `opencode.ts` `OPENCODE_CHAT_OPTS` (`enablePromptCache: true`); `httpErrors.ts` `shouldRetryOmitCacheKey` (400/422 field-rejection retry); `openai.ts` `omitCacheKey` override through `buildOpenAiCompatBody` + chat retry loop + re-export. The fallback was promoted from evidence-gated-optional to shipped: web research found `pi-opencode-go-cache`, a third-party extension for this exact gateway, documenting GLM-family Go models rejecting cache instrumentation (it skip-lists glm-5.1/5.2).
- **Gates:** tsc node+web OK; eslint exit 0; vitest 121/121 (opencodeProvider 16, openaiStreamOptions 44, providerHttpErrors 14, providerStreams 47).
- **Bundle liveness:** `out/main/index.js` carries the fix (grep verified post-build).
- **Task 4 protocol change → VERIFIED (19:45 local):** with the app closed I launched the fixed bundle from a detached HEAD worktree (built from 33dde67 exactly, junctioned node_modules) with a fresh CDP port and drove a real probe run (`1d54824a`, 6 steps, opencode/glm-5.3-flash, approvals off) through the real preload bridge. Result: cache reads engage from step 3 — 12,608 cached tokens/step, 63–65% per-step hit, **43.1% overall vs the 3.8–10% baseline**, zero-streaks eliminated (max 0 vs 5+ before), all numbers provider-reported and internally consistent. Two audit-side traps were caught and corrected along the way: (1) a watchdog mtime-cutoff initially mis-flagged old-bundle run d8d9ef8d as post-fix — invoke-boundary timestamps proved steps 37–43 all belonged to one pre-fix invoke; (2) the main-tree `out/` build stalled at boot because it had baked in the parallel session's uncommitted WIP — the worktree HEAD build boots cleanly, which also exonerates the cache fix for the stall.
