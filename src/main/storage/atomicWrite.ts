import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'fs'
import { dirname } from 'path'

export function atomicWriteFile(target: string, content: string, mode = 0o644): void {
  const dir = dirname(target)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const temp = `${target}.tmp`
  try {
    writeFileSync(temp, content, { encoding: 'utf8', mode })
    renameSync(temp, target)
    try { chmodSync(target, mode) } catch { /* Windows may ignore; continue */ }
  } catch (err) {
    try { unlinkSync(temp) } catch { /* ignore */ }
    throw err
  }
}

/** Atomic write for binary payloads (e.g. generated PNG/JPEG). */
export function atomicWriteBuffer(target: string, content: Buffer, mode = 0o644): void {
  const dir = dirname(target)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const temp = `${target}.tmp`
  try {
    writeFileSync(temp, content, { mode })
    renameSync(temp, target)
    try {
      chmodSync(target, mode)
    } catch {
      /* Windows may ignore; continue */
    }
  } catch (err) {
    try {
      unlinkSync(temp)
    } catch {
      /* ignore */
    }
    throw err
  }
}

export function atomicWriteJson(target: string, data: unknown, mode = 0o644): void {
  atomicWriteFile(target, JSON.stringify(data, null, 2), mode)
}
