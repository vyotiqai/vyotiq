import { appendFile, open, rename, stat, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { logger } from '../../shared/logger'

/** Rotate events.jsonl once it grows past this size; the most recent tail is kept. */
export const EVENTS_FILE_MAX_BYTES = 2 * 1024 * 1024
const EVENTS_FILE_KEEP_BYTES = 1024 * 1024

/** Per-run-dir serialized append chain — ordered, non-blocking, single-writer safe. */
const appendChains = new Map<string, Promise<void>>()
const lastErrors = new Map<string, Error>()
/** First mid-run append failure per dir that has not yet been consumed as a notice. */
const pendingNotices = new Map<string, Error>()

function recordAppendError(dir: string, err: unknown): void {
  const error = err instanceof Error ? err : new Error(String(err))
  lastErrors.set(dir, error)
  if (!pendingNotices.has(dir)) pendingNotices.set(dir, error)
}

function takeAppendError(dir: string): Error | undefined {
  const err = lastErrors.get(dir)
  if (err) lastErrors.delete(dir)
  return err
}

/** Consume the first unread mid-run append failure for a run dir, if any. */
export function takeEventAppendFailureNotice(dir: string): Error | undefined {
  const err = pendingNotices.get(dir)
  if (err) pendingNotices.delete(dir)
  return err
}

function throwIfAppendError(dir: string): void {
  const err = takeAppendError(dir)
  if (err) throw err
}

/** Read approximately the last `byteBudget` bytes, aligned to a line boundary. */
async function readFileTail(path: string, byteBudget: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const size = (await handle.stat()).size
    if (size <= 0) return ''
    const start = Math.max(0, size - byteBudget)
    const length = size - start
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, start)
    let text = buf.toString('utf8')
    if (start > 0) {
      const firstNl = text.indexOf('\n')
      text = firstNl >= 0 ? text.slice(firstNl + 1) : text
    }
    return text
  } finally {
    await handle.close()
  }
}

/**
 * Rewrite events.jsonl keeping only the recent tail once it exceeds the cap.
 * Runs inside the serialized append chain so it stays single-writer safe.
 */
async function rotateEventsFileIfNeeded(path: string, dir: string): Promise<void> {
  let size = 0
  try {
    size = (await stat(path)).size
  } catch {
    return // file does not exist yet — the append will create it
  }
  if (size <= EVENTS_FILE_MAX_BYTES) return
  const tail = await readFileTail(path, EVENTS_FILE_KEEP_BYTES)
  const temp = `${path}.tmp`
  await writeFile(temp, tail, 'utf8')
  await rename(temp, path)
  logger.info('Rotated events.jsonl', {
    scope: 'state',
    code: 'EVENTS_ROTATED',
    correlationId: basename(dir)
  })
}

export function enqueueEventAppend(dir: string, event: unknown): void {
  const line = `${JSON.stringify({ at: new Date().toISOString(), event })}\n`
  const path = join(dir, 'events.jsonl')
  const prev = appendChains.get(dir) ?? Promise.resolve()
  const next = prev
    .then(async () => {
      await rotateEventsFileIfNeeded(path, dir)
      await appendFile(path, line, 'utf8')
    })
    .catch((err) => {
      recordAppendError(dir, err)
      logger.warn('Failed to append events.jsonl', {
        scope: 'state',
        correlationId: basename(dir),
        err
      })
    })
    .finally(() => {
      // Drop settled chains so long sessions do not retain every Promise forever.
      if (appendChains.get(dir) === next) appendChains.delete(dir)
    })
  appendChains.set(dir, next)
}

export async function flushEventAppends(dir?: string): Promise<void> {
  if (dir) {
    await appendChains.get(dir)
    throwIfAppendError(dir)
    return
  }
  await Promise.all([...appendChains.values()])
  if (lastErrors.size === 0) return
  const errors = [...lastErrors.values()]
  lastErrors.clear()
  throw errors[0]
}

/**
 * Block until pending appends for a run dir settle (sync loaders only).
 * Returns false when the wait timed out (caller should treat events as possibly stale).
 * Times out instead of hanging forever when the chain never settles.
 */
export function blockUntilEventAppendsFlushed(dir: string, timeoutMs = 3000): boolean {
  const chain = appendChains.get(dir)
  if (!chain) {
    throwIfAppendError(dir)
    return true
  }
  const sab = new SharedArrayBuffer(4)
  const ia = new Int32Array(sab)
  let flushError: Error | undefined
  void chain
    .then(() => {
      flushError = takeAppendError(dir)
    })
    .catch((err) => {
      flushError = err instanceof Error ? err : new Error(String(err))
    })
    .finally(() => {
      Atomics.store(ia, 0, 1)
      Atomics.notify(ia, 0)
    })
  const result = Atomics.wait(ia, 0, 0, timeoutMs)
  if (result === 'timed-out') {
    logger.warn('Timed out waiting for event append flush', {
      scope: 'state',
      correlationId: basename(dir),
      timeoutMs
    })
    return false
  }
  if (flushError) throw flushError
  return true
}

/** @internal Test helper — how many run dirs still have a pending chain. */
export function appendChainSizeForTests(): number {
  return appendChains.size
}

export function resetEventAppendQueueForTests(): void {
  appendChains.clear()
  lastErrors.clear()
  pendingNotices.clear()
}
