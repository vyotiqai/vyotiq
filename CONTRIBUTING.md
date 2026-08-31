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

## Releasing (pushing app updates)

Installed builds auto-update from GitHub Releases via electron-updater: they check at
startup and every 6h (toggle in Settings → About), download the update automatically,
and install it when the app quits. Status is surfaced in Settings → About and toasts.

1. Bump `version` in `package.json`.
2. Commit, tag, and push: `git commit -am "release: v1.2.3" && git tag v1.2.3 && git push origin main v1.2.3`.
3. `.github/workflows/release.yml` packages Windows (NSIS), macOS (arm64+x64 dmg+zip),
   and Linux (AppImage), then publishes them with `latest*.yml` metadata to the tagged
   GitHub Release. Running installs pick it up on their next update check.

Notes:

- Windows and Linux auto-update work with unsigned builds (`win.publisherName` stays
  unset until a signing cert exists — see `electron-builder.yml`).
- macOS auto-update requires a **signed** build (hard Squirrel.Mac requirement): set
  `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
  `APPLE_TEAM_ID` in repo secrets. Unsigned mac releases must be updated manually via DMG.
- Dev builds never check for updates (`app.isPackaged` gate in `src/main/app/updater.ts`).
