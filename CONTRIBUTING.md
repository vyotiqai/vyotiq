# Contributing

## Requirements

- Node.js >= 22.18
- pnpm 11.22.0 (`packageManager` in `package.json`; Corepack can enable it)

## Setup

```bash
pnpm install
pnpm dev
```

Copy `.env.example` to `.env` only if you need a Sentry DSN.

## Checks

Run the same gates CI runs:

```bash
pnpm typecheck
pnpm test
pnpm lint
```

Single test file:

```bash
pnpm exec vitest run tests/main/unit/<name>.test.ts
```

## Pull requests

- Target `main`.
- Keep the change scoped to the problem.
- Do not commit `.env`, API keys, or generated `landing/src/content/docs/**/*.md` (those are produced from `.md.docx` on install).
- Security reports go through [SECURITY.md](SECURITY.md), not public issues.
