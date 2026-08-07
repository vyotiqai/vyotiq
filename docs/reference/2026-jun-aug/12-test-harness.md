# Test harness

## Vitest (`vitest.config.ts`)

| Setting | Value |
|---------|-------|
| Include | `tests/**/*.test.ts`, `tests/**/*.test.tsx` |
| Exclude | `tests/gui-e2e/**` |
| Environment | `node` (default) |
| Setup | `tests/setup.ts` |
| Pool | `forks` |
| Timeout | 30s |
| Aliases | `@main`, `@shared`, `@renderer` |

Coverage (v8): `src/main/**`, `src/shared/**`, `src/renderer/src/**`.

### Layout

```
tests/main/unit/          Main-process unit tests
tests/main/integration/   IPC contract tests
tests/main/e2e/           Agent pipeline e2e (mocked, no GUI)
tests/renderer/           React component/hook tests
tests/shared/             Shared module tests
tests/gui-e2e/            Playwright Electron GUI tests
tests/fixtures/           Test fixtures
```

### Baseline counts (2026-08-07)

- **263** test files
- **2338** tests passed, **5** skipped

### Setup helpers (`tests/setup.ts`)

- localStorage stub, `matchMedia` mock
- `@testing-library/react` cleanup
- `resetActiveRunsForTests`

## Playwright gui-e2e (`tests/gui-e2e/`)

Separate from Vitest e2e. Requires prior `pnpm build`.

| File | Role |
|------|------|
| `playwright.config.ts` | 1 worker, 60s timeout, no retries |
| `helpers/launch.ts` | Launches `out/main/index.js` via `@playwright/test` `_electron` |
| `app.smoke.spec.ts` | Window open, sidebar toggle, settings navigation |

Script: `pnpm test:gui-e2e`

**Does not test** agent browser tools — shell smoke only.

## Vitest main e2e (`tests/main/e2e/`)

- `agentPipeline.test.ts` — full `runAgent` with mocked provider
- `smoke.test.ts`, `ptyLifecycle.test.ts`, `workspaceCacheInvalidation.test.ts`

Script: `pnpm test:e2e`

## Harness gate tests

`HARNESS_EVAL_TESTS` includes `harnessHeldOutEval.test.ts` — frozen grader; never auto-applies via harness-apply.

## Verification commands

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm test:coverage
pnpm test:e2e
pnpm test:gui-e2e   # requires pnpm build first
```

## Evidence

- `vitest.config.ts`, `tests/setup.ts`
- `tests/gui-e2e/playwright.config.ts`
- `package.json` scripts
- `tests/main/integration/ipcContract.test.ts`
