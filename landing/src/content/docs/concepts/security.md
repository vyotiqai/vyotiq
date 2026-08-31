---
title: Security and approval model
description: Understand mode boundaries, tool approval, path guards, browser restrictions, and residual risk.
section: concepts
order: 3
type: concept
audience: Security-conscious users
related:
  - concepts/privacy-data
  - agent/modes
  - tools/browser
---

Agent V uses layered controls. No single control makes agent output or third-party content trustworthy.

## Mode boundary

Ask exposes read-only built-ins and browse-only browser actions. Plan adds todos, diagnostics, and writes only to run plan.md and contract.md (plus .hermes/plans/<id>.md plan artifacts). Agent exposes the full built-in catalog. MCP server calls are Agent-only because server annotations cannot be trusted as a security gate.

Automatic mode switching is off by default. When it is off, only the user can change modes.

## Tool approval

[Settings → Tools](/docs/reference/settings#tools) → `Tool approval` defaults to Off:

- **Ask for edits and commands** gates mutating tools.
- **Ask for every tool** gates reads as well.
- Allowlisted tool names skip later prompts until removed.

Autonomous mode can approve normally gated tools, but high-risk actions remain gated. Read the approval's tool name, arguments, workspace, and risk text before accepting.

## Workspace and path guards

File operations resolve against the workspace and reject escapes. Memory has an additional .vyotiq/memory boundary. Agent instances without a worktree require a write `path_scope`. Run directories validate IDs and reject symlink escape.

Terminal commands and external tools can still cause effects that a file checkpoint cannot reverse.

## Browser and network

The embedded browser treats page content as untrusted. Browser domain allowlist can restrict every navigation and redirect to exact hosts or *.suffix entries. Empty removes that extra host filter but built-in SSRF checks still apply.

Provider requests, remote MCP calls, GitHub operations, and browser navigation cross the local boundary. Review the destination and content before approval.

## Secrets and diagnostics

API keys, MCP bearer tokens, and GitHub tokens use Electron safeStorage where available. Local rotating logs are always written. Opt-in crash/error reporting is available only when the build has a Sentry DSN and excludes chat contents, keys, and file bodies.

## Residual risk

Models can make incorrect decisions. External pages, packages, skills, rules, prompts, and MCP output can be malicious. Keep least-privilege credentials, narrow workspaces, approval gates, Git review, and backups. Keep, Discard, and /undo only cover checkpointed agent writes.
