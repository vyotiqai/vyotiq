# Marketplace skills and rules (supplementary)

Bundled at `resources/marketplace/packages/`. Labelled **supplementary** in
`docs/agent-practices-2026.md` — not June–August 2026 audit docs.

Enabled skills contribute name/description metadata to the system prompt;
full instructions load via `Skill` tool or slash command.

## Rules (4)

| File | Themes |
|------|--------|
| `devtools/rules/conventions.md` | Small verified changes; don't invent APIs; rebuild after Electron changes |
| `quality/rules/quality.md` | Severity-first findings; actionable fixes; flag missing tests |
| `shipping/rules/shipping.md` | Small reviewable changesets; test plans; match repo style |
| `electron-app/rules/electron.md` | Main/renderer separation; typed IPC; no secrets in renderer |

## Skills (18 `SKILL.md` files)

| Package | Themes |
|---------|--------|
| `accessibility` | Semantic HTML, keyboard/focus, WCAG AA, reduced motion |
| `api-design` | Stable contracts, additive evolution |
| `code-review` | Diff review: bugs, regressions, security |
| `commit-message` | Why-focused messages; match repo style |
| `debug` | Reproduce → hypothesize → fix |
| `docs` | Accurate scannable docs; cite real files |
| `frontend-design` | Design system first; restrained motion |
| `pr-description` | Summary, risks, test plan |
| `refactor` | Behavior-preserving; small steps |
| `security-review` | Auth, injection, XSS, SSRF, secrets, path traversal |
| `test-writing` | Match project conventions; behavior-focused |
| `devtools/debug-checklist` | Short debug checklist |
| `electron-app/electron-workflow` | Main/preload/renderer, IPC, packaging |
| `quality/code-review` | Duplicate of top-level code-review |
| `quality/security-review` | Duplicate of top-level security-review |
| `shipping/commit-message` | Duplicate of commit-message |
| `shipping/pr-description` | Duplicate of pr-description |
| `shipping/test-writing` | Duplicate of test-writing |

## Devtools plugin

`resources/marketplace/packages/devtools/vyotiq.plugin.json` — debug-checklist skill + conventions rule; `mcp: []`.

## Evidence

- `resources/marketplace/packages/**/SKILL.md`
- `resources/marketplace/packages/**/rules/*.md`
- `src/main/marketplace/` — install, catalog, resolve
- `src/renderer/src/features/marketplace/`
