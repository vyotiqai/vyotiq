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
- Documentation shipped as `.docx` (e.g. `docs/reference/**`, `resources/harness/*.docx`, marketplace `SKILL.md.docx`) is matched by the `*.docx` rule in `.gitignore` and will be **silently ignored** by `git add`. Force-add new or moved doc files with `git add -f <path>` and verify with `git status --ignored`.
- Security reports go through [SECURITY.md](SECURITY.md), not public issues.
