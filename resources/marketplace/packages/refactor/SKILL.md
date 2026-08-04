---
name: refactor
description: Restructure code while preserving behavior: extract, rename, simplify, and cleanup in small reviewable steps. Use when refactoring, cleaning up, extracting helpers, renaming for clarity, or simplifying structure without changing intent.
metadata:
  version: "1.0.0"
---

# Refactor

## Instructions
1. Preserve behavior unless the user explicitly asks for a behavior change.
2. Prefer small, reviewable steps over large rewrites.
3. Keep public APIs stable unless renaming is part of the request.
4. Reuse existing project patterns; do not introduce a new architecture casually.
5. Update or add tests when the change touches risky paths.
6. Leave unrelated code alone; no drive-by cleanup in adjacent files.
7. Summarize what moved and why in the final response.
