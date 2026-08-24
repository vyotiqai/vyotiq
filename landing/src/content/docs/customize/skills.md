---
title: Skills
description: Create personal or project SKILL.md packages, understand discovery precedence, and load them in a run.
section: customize
order: 5
type: guide
audience: Workflow authors
owner: Vyotiq product
lastVerified: 1.0.0
sources:
  - src/renderer/src/features/marketplace/MarketplaceSkillsPane.tsx
  - src/main/agent/skills/local.ts
  - src/main/agent/skills/parse.ts
  - src/main/agent/slashCommands/skills.ts
related:
  - customize/slash-commands
  - customize/rules
  - reference/tools
---

A Skill is a directory containing SKILL.md. Its frontmatter names and describes the workflow; its body supplies instructions the agent can load when the task matches.

## Locations and precedence

Agent V discovers:

1. Project skills in {workspace}/.vyotiq/skills/<name>/SKILL.md.
1. Compatible project skills in {workspace}/.cursor/skills/<name>/SKILL.md.
1. Personal skills in ~/.vyotiq/skills/<name>/SKILL.md.

Project sources are scanned before personal sources. When names collide, the first discovered name wins. Discovery is bounded to 64 local skills.

## Create a skill

Use Marketplace → Manage → **Skills** or /create-skill. /create-skill personal targets the personal scope; the default command description creates under .vyotiq/skills/.

A minimal file is:

```yaml
---
name: verify-release
description: Verify a built release and report concrete artifacts.
---
```

Use the repository's real release command. Confirm the output path on disk.

Never claim packaging succeeded from command exit alone.

Keep the description specific enough for selection. Put reusable instructions in the body and supporting files inside the same skill directory.

## Use a skill

The Skill built-in loads an enabled skill or a relative file under that skill. Skill-derived slash commands can also appear in the composer. A skill provides instructions; it does not bypass mode policy, tool approval, path guards, or higher-priority constraints.

## Refresh behavior

Marketplace editing clears the local skill cache, and filesystem fingerprints refresh discovery. New or changed skills should appear without restarting the application. If a skill is missing, verify the file is named SKILL.md, the frontmatter parses, the directory is not a symlink, and another source did not already claim the same name.
