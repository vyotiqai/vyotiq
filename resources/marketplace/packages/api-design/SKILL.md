---
name: api-design
description: Design or change HTTP, IPC, and SDK API contracts, schemas, errors, and versioning. Use when adding endpoints, changing request/response shapes, IPC channels, client SDKs, or debating breaking vs additive API changes.
metadata:
  version: "1.0.0"
---

# API design

## Instructions
1. Prefer explicit, stable contracts; avoid ambiguous optional fields.
2. Match existing naming, error shapes, and versioning in the project.
3. Document breaking changes and migration paths clearly.
4. Validate inputs at the boundary; return actionable errors.
5. Keep auth and tenancy rules consistent with neighboring endpoints.
6. Prefer additive evolution over silent behavior changes.
7. Include a minimal request/response example when introducing something new.

## Examples
- Additive: new optional field with a default — no client break.
- Breaking: rename/remove a required field — require a migration note.
