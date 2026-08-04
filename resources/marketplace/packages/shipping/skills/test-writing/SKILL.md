---
name: test-writing
description: Add, fix, or expand automated tests (unit, integration, UI) matching project conventions. Use when writing tests, fixing failing tests, improving coverage on a risky path, or when the user asks for test help.
metadata:
  version: "1.0.0"
---

# Test writing

## Instructions
1. Match the project's existing test runner, layout, and assertion style.
2. Cover the failing or risky path first; avoid speculative broad suites.
3. Prefer focused cases with clear arrange / act / assert structure.
4. Assert observable behavior, not private implementation details.
5. Name tests after the behavior under test.
6. Re-run the relevant tests after changes and fix failures you introduce.
7. Ask 1–2 clarifying questions only when intended behavior is ambiguous.
