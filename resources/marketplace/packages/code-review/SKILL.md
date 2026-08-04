---
name: code-review
description: Structured code review of diffs and pull requests: bugs, regressions, missing tests, and security. Use when reviewing a PR, diff, changeset, or when the user asks for a code review.
metadata:
  version: "1.0.0"
---

# Code review

## Instructions
1. Summarize what changed and the highest-risk areas.
2. List bugs, regressions, and missing tests — highest severity first.
3. Call out security and data-handling issues explicitly.
4. Suggest concrete fixes; avoid vague advice.
5. Ask 1–2 clarifying questions only when blocked.

## Output shape
- Summary
- Findings (severity-ordered)
- Questions (only if needed)
