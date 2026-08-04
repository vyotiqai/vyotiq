---
name: electron-workflow
description: Work safely across Electron main, preload, renderer, IPC, and packaging. Use when changing Electron processes, IPC, preload bridges, desktop UX, or packaging/dev vs packaged paths.
metadata:
  version: "1.0.0"
---

# Electron workflow

## Instructions
1. Confirm whether the change belongs in main, preload, renderer, or shared.
2. Update IPC schemas and handlers together; keep types in sync.
3. Avoid Node APIs in the renderer; go through preload bridges.
4. Test the affected path after rebuild when IPC or main-process code changes.
5. Keep packaging and path assumptions explicit (dev vs packaged resources).
6. Prefer small, verified patches over broad process rewrites.
