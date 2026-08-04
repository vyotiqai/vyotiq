# Electron app conventions

- Keep main-process and renderer concerns separated; use typed IPC schemas.
- Prefer shared domain types under `src/shared` over duplicating contracts.
- Do not put secrets in renderer code or committed config.
- After app-affecting code changes, rebuild and restart Electron rather than assuming hot reload.
- Prefer existing UI primitives in the design system over one-off components.
