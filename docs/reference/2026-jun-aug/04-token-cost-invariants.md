# Token-cost freeze invariants

**Research doc:** `docs/research/token-cost-jun-aug-2026.md` is a stub pointer. Canonical
substitute: this file + freeze tests + `contextBudget.ts`.

Do not weaken these without an explicit product decision.

## Compaction trigger

For a 1M context window with 0.5 trigger ratio, compaction fires at the **soft cap**
(64k tokens), not at ratio×content:

```typescript
COMPACTION_SOFT_CAP_TOKENS = 64_000
```

`compactionTriggerFromRaw(1_000_000, 0.5)` returns `64_000`.

## Tools budget soft cap

```typescript
TOOLS_SOFT_CAP_TOKENS = 8_000
```

Without this, the 18% tools share on a 1M window (~180k) never sheds MCP schemas.
Cap aligns with lean-catalog + pin practice (`request_mcp_tools`).

## MCP pin TTL and soft max

```typescript
MCP_PIN_IDLE_TTL_STEPS = 16
MCP_PINNED_SOFT_MAX = 12
```

- TTL 16: tuned from AppData session `80bd4074` (read/terminal-heavy gaps between MCP uses).
- Soft max 12: excess pinned MCP schemas LRU-evicted; required builtins untouched.

## Billed input semantics

`billedInputTokens` = **Σ step inputs**, not latest window peak.

Example from freeze test: steps `[30k, 42k, 47k, 40k, 35k]` →
`billedInputTokens = 194k`, `peakInputTokens = 47k`, `inputTokens = 35k` (latest).

`stepUsageTotalsFromPersistedEvents` rebuilds billed Σ from durable `inputTokens`
and ignores carried `billedInputTokens` fields on persisted events.

## Budget layer shares

From `src/shared/domain/contextBudget.ts`:

| Layer | Share |
|-------|-------|
| system | 0.12 |
| tools | 0.18 |
| memoryWorkspace | 0.15 |
| history | 0.40 |
| buffer | 0.15 |

`DEFAULT_CONTEXT_WINDOW = 128_000`, `DEFAULT_COMPACTION_TRIGGER_RATIO = 0.7`.

## Evidence

- `src/shared/domain/contextBudget.ts` — constants and `compactionTriggerFromRaw`, `toolsBudgetFromRaw`
- `tests/shared/tokenCostRegression.invariants.test.ts` — freeze regression suite
- `src/shared/utils/runTelemetry.ts` — `mergeStepUsageTotals`, `stepUsageTotalsFromPersistedEvents`
- `tests/main/unit/toolsBudget.test.ts`
