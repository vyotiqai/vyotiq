# June–August 2026 Verified Reference

Durable, evidence-backed reference for Vyotiq Agent V. Synthesized from repo docs,
harness, code, and tests only — no speculative guidance.

**Snapshot:** 2026-08-07 · git `9f35b85` (working tree has uncommitted changes; see
[14-codebase-audit-snapshot.md](./14-codebase-audit-snapshot.md)).

## Scope

| Included | Excluded |
|----------|----------|
| `docs/agent-practices-2026.md`, harness, handbook | External Cursor plans, plugin rules |
| `src/` implementation + `tests/` | Global Cursor skills outside repo |
| Marketplace bundled skills/rules | Unverified third-party docs |

## Index

| File | Topic |
|------|-------|
| [01-practices-checkpoints.md](./01-practices-checkpoints.md) | Checkpoint semantics, revert surfaces, tool coverage, persistence |
| [02-practices-operations.md](./02-practices-operations.md) | Operational practices, dev launch, verification gate |
| [03-performance-diagnostics.md](./03-performance-diagnostics.md) | Perf tooling, verified UI caps, manual repro matrix |
| [04-token-cost-invariants.md](./04-token-cost-invariants.md) | Freeze invariants (compaction, MCP pin, billed Σ) |
| [05-harness-and-prompt.md](./05-harness-and-prompt.md) | System prompt assembly, harness policy, review/apply |
| [06-security-patterns.md](./06-security-patterns.md) | Renderer sandbox, path/URL guards, secrets, write limits |
| [07-browser-tools.md](./07-browser-tools.md) | Agent browser (`WebContentsView`), 13 `browser_*` tools |
| [08-terminal-and-pty.md](./08-terminal-and-pty.md) | `terminal` tool, PTY dock, output caps |
| [09-ipc-and-contracts.md](./09-ipc-and-contracts.md) | IPC channels, Zod schemas, preload API |
| [10-ui-ux-patterns.md](./10-ui-ux-patterns.md) | Composer, sidebar, dock panels, virtualization |
| [11-marketplace-skills.md](./11-marketplace-skills.md) | Bundled marketplace skills and rules (supplementary) |
| [12-test-harness.md](./12-test-harness.md) | Vitest, Playwright gui-e2e, verification commands |
| [13-feature-inventory.md](./13-feature-inventory.md) | Tools, providers, panels, modes |
| [14-codebase-audit-snapshot.md](./14-codebase-audit-snapshot.md) | Full audit snapshot, gaps, working-tree delta |
| [15-architecture.md](./15-architecture.md) | Process boundaries, aliases, folder conventions |

Canonical short summary: [`docs/agent-practices-2026.md`](../../agent-practices-2026.md).

## Verification gate

Run after doc or code changes:

```bash
pnpm typecheck
pnpm test
pnpm lint
```

**Baseline (2026-08-07):** typecheck pass · 263 test files, 2338 passed, 5 skipped · lint pass.

**Final gate (post-reference docs):** typecheck pass · 263 test files, 2338 passed, 5 skipped · lint pass.

## Maintenance

1. Land behavior changes in code/tests first, then update the matching topic file.
2. Every claim must cite a file path or test name in the **Evidence** section.
3. Prefer extending an existing topic file over adding new files.
4. Re-run the verification gate on each update.
5. Update the snapshot date and git hash in this README when committing reference changes.

## Known doc gaps

| Referenced path | Status |
|-----------------|--------|
| `docs/research/token-cost-jun-aug-2026` | Stub pointer → [04-token-cost-invariants.md](./04-token-cost-invariants.md) |
| `docs/architecture.md` | Stub pointer → [15-architecture.md](./15-architecture.md) |
