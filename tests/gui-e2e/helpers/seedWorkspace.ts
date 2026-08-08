import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { workspaceIdFromPath } from '../../../src/shared/utils/workspaceId'
import { canonicalizeWorkspacePath } from '../../../src/shared/utils/workspacePath'

export type SeededRun = {
  runId: string
  goal: string
  updatedAt?: string
}

/** Write run status files into the Electron userData sessions tree. */
export function seedRunsInUserData(
  userDataDir: string,
  workspacePath: string,
  runs: SeededRun[]
): void {
  const canonical = canonicalizeWorkspacePath(workspacePath)
  const id = workspaceIdFromPath(canonical)
  const sessionsRoot = join(userDataDir, 'workspaces', id, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  for (const [index, run] of runs.entries()) {
    const dir = join(sessionsRoot, run.runId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'status.json'),
      JSON.stringify(
        {
          status: 'done',
          step: 0,
          updatedAt: run.updatedAt ?? `2026-08-08T00:00:${String(index).padStart(2, '0')}.000Z`,
          goal: run.goal,
          workspacePath: canonical
        },
        null,
        2
      ),
      'utf8'
    )
    writeFileSync(
      join(dir, 'messages.jsonl'),
      `${JSON.stringify({ role: 'user', content: run.goal })}\n`,
      'utf8'
    )
  }
}
