---
title: Browser and terminal issues
description: Resolve blocked hosts, navigation failures, shared-control stalls, missing shells, and PTY fallback.
section: troubleshooting
order: 3
type: troubleshooting
audience: Browser and terminal users
related:
  - tools/browser
  - tools/terminal
  - concepts/security
---

## Browser host is blocked

Open [Settings → Tools](/docs/reference/settings#tools) → Browser domain allowlist. Confirm the destination is an exact listed hostname or matches a *.suffix entry. Redirect targets are checked too.

Empty removes the extra allowlist, but built-in URL and SSRF protections still reject unsafe destinations. Do not disable a restriction without verifying the target.

## Browser navigation or tool reference fails

1. Confirm the panel has an active tab.
1. Use Reload once.
1. After navigation or mutation, take a fresh snapshot before the agent uses element references.
1. Check whether You have control of the browser is shown. Choose Return to agent if an agent step is waiting.
1. Preserve Browser state unavailable or the navigation error text.

Element references belong to a current snapshot and can become stale after page changes.

## Clear session data

Use Clear Browsing History, Clear Cookies, or Clear Cache only for the relevant symptom. Clearing cookies signs out browser sessions. These controls affect the embedded browser, not the operating system's default browser.

## Terminal shell does not start

Open [Settings → Tools](/docs/reference/settings#tools) → Terminal shell. Choose an installed shell. Auto prefers PowerShell on Windows; selecting Bash does not install Bash.

Confirm the active workspace exists and the shell executable is available on PATH.

## PTY unavailable or interaction is degraded

The app can use a pipe fallback when the native PTY is unavailable. Preserve the warning and test a simple non-interactive command. Features requiring full terminal emulation may remain unavailable until native dependencies are valid.

## A command appears stuck

Use the named terminal session or run Stop control. Do not terminate broad Electron, Node, or pnpm process groups. Check whether the command is legitimately waiting for input, an approval, network, or a child process before closing it.
