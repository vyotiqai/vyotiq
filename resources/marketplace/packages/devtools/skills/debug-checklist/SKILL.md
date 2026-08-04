---
name: debug-checklist
description: Short debug checklist for failing tests, crashes, and unexpected runtime behavior. Use when debugging with a quick checklist, triage a failure, or when the Devtools plugin debug skill is requested.
metadata:
  version: "1.0.0"
---

# Debug checklist

## Instructions
1. Reproduce with the smallest failing case.
2. Read the error and stack carefully before changing code.
3. Form one hypothesis; gather evidence; only then patch.
4. Prefer logging or a focused test over large speculative edits.
5. Confirm the fix with a re-run of the failing path.
