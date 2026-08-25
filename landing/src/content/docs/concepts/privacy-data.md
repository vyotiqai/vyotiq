---
title: Privacy and data storage
description: Map local data, provider-bound content, credentials, logs, indexes, memory, and deletion boundaries.
section: concepts
order: 4
type: concept
audience: All users and auditors
related:
  - reference/storage
  - concepts/security
  - tools/voice-dictation
---

Agent V is local-first, not offline-only. The desktop process stores product state locally, while configured providers and integrations receive the content required for each request.

## Stored locally

App and workspace state stay on this machine. [Storage locations](/docs/reference/storage) lists what exists and where. Workspace `.vyotiq/memory/`, `.vyotiq/rules/`, and `.vyotiq/skills/` are ordinary project files and can enter version control.

## Content sent elsewhere

A configured model provider receives prompts, selected context, attachments, tool results used in the next step, and required model parameters. **OpenAI** or **OpenRouter** dictation receives recorded audio when selected.

Remote MCP servers receive invoked tool arguments or resource/prompt requests. Browser navigation contacts the target website. GitHub operations contact GitHub. A remote Ollama or Custom host is remote even when its API is compatible with a local service.

## Credentials

Provider keys, MCP bearer tokens, and GitHub tokens use Electron safeStorage where the operating system supports it. Do not copy secrets into chat, workspace files, logs, rules, or skills.

## Logs and reporting

Local rotating logs are always written and can be opened through [Settings → General](/docs/reference/settings) → Logs. Share crash & error reports is opt-in and available only in a build with a Sentry DSN. That reporting path excludes chat contents, API keys, and file bodies.

## Notifications and desktop privacy

Inbox items are stored locally when notifications and their category are enabled. OS notification titles and bodies can appear outside the app; select Off when the desktop surface is not private.

## Retention and deletion

Windows uninstall does not delete app data automatically. Removing a workspace tab also does not mean all persisted run state was erased. Delete project files, app-data state, downloaded models, indexes, packages, and external-provider data through their own boundaries. See Storage locations before manual cleanup.

## The public website

The public site is a separate surface from this application. Theme storage and optional cookieless analytics for that site are documented on [Website privacy](/privacy).
