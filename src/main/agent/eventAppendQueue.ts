import { appendFile, open, readdir, rename, stat, unlink, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { logger } from '../../shared/logger'

/** Rotate events.jsonl once it grows past this size; the most recent tail is kept. */
export const EVENTS_FILE_MAX_BYTES = 2 * 1024 * 1024
export const EVENTS_FILE_KEEP_BYTES = 1024 * 1024
const MAX_EVENT_ARCHIVES = 5
const EVENT_ARCHIVE_PREFIX = 'events.archive.'

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

function archiveFilename(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${EVENT_ARCHIVE_PREFIX}${stamp}.jsonl`
}

async function listEventArchives(dir: string): Promise<string[]> {
  const names = await readdir(dir)
  return names
    .filter((name) => name.startsWith(EVENT_ARCHIVE_PREFIX) && name.endsWith('.jsonl'))
    .sort()
}

async function enforceArchiveCap(dir: string): Promise<void> {
  const archives = await listEventArchives(dir)
  while (archives.length >= MAX_EVENT_ARCHIVES) {
    const oldest = archives.shift()
    if (!oldest) break
    await unlink(join(dir, oldest))
  }
}

async function archiveDiscardedHead(dir: string, head: string): Promise<void> {
  if (!head) return
  await enforceArchiveCap(dir)
  const filename = archiveFilename()
  const archivePath = join(dir, filename)
  const temp = `${archivePath}.tmp`
  await writeFile(temp, head, 'utf8')
  await rename(temp, archivePath)
  const byteCount = Buffer.byteLength(head, 'utf8')
  logger.info('Archived rotated events head', {
    scope: 'state',
    code: 'EVENTS_ARCHIVED',
    correlationId: basename(dir),
    filename,
    byteCount
  })
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
  const targetSplit = size - EVENTS_FILE_KEEP_BYTES
  if (targetSplit <= 0) return

  const handle = await open(path, 'r')
  let head = ''
  let tail = ''
  try {
    const headLen = Math.min(size, targetSplit)
    const headBuf = Buffer.alloc(headLen)
    await handle.read(headBuf, 0, headLen, 0)
    const headText = headBuf.toString('utf8')
    const lastNl = headText.lastIndexOf('\n')
    let splitAt = 0
    if (lastNl >= 0) {
      splitAt = lastNl + 1
      head = headText.slice(0, splitAt)
      const tailLen = size - splitAt
      const tailBuf = Buffer.alloc(tailLen)
      await handle.read(tailBuf, 0, tailLen, splitAt)
      tail = tailBuf.toString('utf8')
    } else {
      const restLen = size - targetSplit
      const restBuf = Buffer.alloc(restLen)
      await handle.read(restBuf, 0, restLen, targetSplit)
      const restText = restBuf.toString('utf8')
      const firstNl = restText.indexOf('\n')
      if (firstNl < 0) return
      splitAt = targetSplit + firstNl + 1
      head = headText + restText.slice(0, firstNl + 1)
      tail = restText.slice(firstNl + 1)
    }
    if (splitAt <= 0 || splitAt >= size) return
  } finally {
    await handle.close()
  }

  await archiveDiscardedHead(dir, head)
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

/** @internal Test helper — how many run dirs still have a pending chain. */
export function appendChainSizeForTests(): number {
  return appendChains.size
}

export function resetEventAppendQueueForTests(): void {
  appendChains.clear()
  lastErrors.clear()
  pendingNotices.clear()
}
