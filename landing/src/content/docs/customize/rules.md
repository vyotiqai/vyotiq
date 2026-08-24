---
title: Rules
description: Author user-global and workspace instructions, understand precedence, and control automatic injection.
section: customize
order: 6
type: guide
audience: Users standardizing agent behavior
owner: Vyotiq product
lastVerified: 1.0.0
sources:
  - src/renderer/src/features/marketplace/MarketplaceRulesPane.tsx
  - src/main/agent/context/rules.ts
  - src/main/agent/context/userRules.ts
  - src/shared/utils/skillMarkdown.ts
related:
  - customize/skills
  - concepts/security
  - reference/settings
---

**Rules** add persistent instructions to agent context. Use Marketplace → Manage → **Rules** to edit user and project sources.

## User rules

User rules are stored in app settings and apply to all chats when enabled and non-empty. A rule has a name and body. Agent V allows up to 16 user rules; names are capped at 64 characters and bodies at 4,000 characters.

User rules cannot override the system constraints, tool policy, or selected mode.

## Workspace rules

The app reads workspace instructions in this order:

1. AGENTS.md
1. CLAUDE.md
1. .cursorrules
1. Markdown or MDC files under .cursor/rules/
1. Markdown files under .vyotiq/rules/

Workspace instructions are assembled after user-global rules and therefore win when the two conflict. A single file is capped at 64 KiB, discovery is bounded to 24 files and three nested directory levels, and symlink-style surprises are avoided by the workspace file boundary.

## Frontmatter

Directory rule files can use:

```yaml
---
description: TypeScript changes in the renderer
globs: ["src/renderer/**/*.ts", "src/renderer/**/*.tsx"]
alwaysApply: true
---
```

Keep Node APIs out of the renderer.

alwaysApply: true or an omitted value injects the body automatically. Explicit alwaysApply: false prevents automatic injection. Because the run does not have a single active-editor file, globs alone do not cause a false rule to auto-inject.

## Create and verify

Use /create-rule to create a workspace rule under .vyotiq/rules/, or use the **Rules** editor. Changes clear the rule cache and should affect subsequent agent steps without an app restart.

Keep each rule narrow and testable. Do not put API keys, tokens, or private chat content in rule files; workspace rules are ordinary project files and can be committed.
