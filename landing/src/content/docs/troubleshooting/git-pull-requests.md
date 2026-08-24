---
title: Git and pull-request issues
description: Resolve missing repositories, commits, remotes, Git identity, GitHub CLI, and authentication.
section: troubleshooting
order: 6
type: troubleshooting
audience: GitHub users
owner: Vyotiq product
lastVerified: 1.0.0
sources:
  - src/renderer/src/features/chat/components/PrPanel.tsx
  - src/renderer/src/features/chat/components/GitChrome.tsx
  - src/main/git/githubAuth.ts
  - src/main/git/ghBinary.ts
related:
  - tools/changes-git
  - tools/pull-requests
  - reference/settings
---

Follow the panel state in order; later GitHub steps cannot repair an earlier Git prerequisite.

## Not a git repository

Open a workspace whose selected folder is inside a Git repository, or initialize the intended project outside the panel. Refresh Changes and Pull Request after the repository exists.

## No commits yet

Create an initial commit before publishing or opening a pull request. Review every staged and unstaged file first. The agent must not invent user.name or user.email; configure Git identity yourself if Git requests it.

## GitHub repository not configured

Confirm the branch and remotes. The pull-request creation flow can connect a matching repository or create a private one, but that is an external mutation and requires confirmation.

## GitHub CLI not found

The panel depends on gh. Install the GitHub CLI using its official platform instructions, ensure it is on PATH, then restart or refresh the application context that discovers it.

## GitHub authentication required

Use Connect GitHub. If device flow requires a client ID, set Settings → Integrations → GitHub client ID or provide `VYOTIQ_GITHUB_CLIENT_ID` to the app environment.

Complete the pending browser/device code flow, then refresh the panel. Do not paste a token into chat.

## No pull request

Confirm the current topic branch has committed changes and is published. Then create a draft pull request from the panel. If a PR already exists for a different branch, switch to the intended branch and refresh.

## Checks are not green

The Checks count only treats successful conclusions as passed. Open the failing check details and fix that failure; a generic completed state is not success.

Collect repository path, branch, remote names without embedded credentials, gh availability/auth status, exact panel error, and app version for support.
