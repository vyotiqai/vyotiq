import { existsSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { atomicWriteJson } from '@main/storage/atomicWrite'
import { LoopCheckpointSchema, type LoopCheckpoint } from '@shared/ipc/schemas/agent'

export const LOOP_CHECKPOINT_FILENAME = 'loopCheckpoint.json'

function checkpointPath(runDir: string): string {
  return join(runDir, LOOP_CHECKPOINT_FILENAME)
}

export function loadLoopCheckpoint(runDir: string): LoopCheckpoint | null {
  const path = checkpointPath(runDir)
  if (!existsSync(path)) return null
  try {
    const parsed = LoopCheckpointSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function saveLoopCheckpoint(runDir: string, checkpoint: LoopCheckpoint): void {
  atomicWriteJson(checkpointPath(runDir), checkpoint)
}

export function clearLoopCheckpoint(runDir: string): void {
  const path = checkpointPath(runDir)
  if (!existsSync(path)) return
  try {
    unlinkSync(path)
  } catch {
    // ignore missing or locked file
  }
}
