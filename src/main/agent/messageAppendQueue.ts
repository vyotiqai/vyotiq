import { appendFile } from 'fs/promises'
import { basename, join } from 'path'
import { logger } from '../../shared/logger'

/** Per-run-dir serialized message append chain — ordered, non-blocking. */
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
export function takeMessageAppendFailureNotice(dir: string): Error | undefined {
  const err = pendingNotices.get(dir)
  if (err) pendingNotices.delete(dir)
  return err
}

function throwIfAppendError(dir: string): void {
  const err = takeAppendError(dir)
  if (err) throw err
}

export function enqueueMessageAppend(dir: string, line: string): Promise<void> {
  const path = join(dir, 'messages.jsonl')
  const prev = appendChains.get(dir) ?? Promise.resolve()
  const next = prev
    .then(() => appendFile(path, line, 'utf8'))
    .catch((err) => {
      recordAppendError(dir, err)
      logger.warn('Failed to append messages.jsonl', {
        scope: 'state',
        correlationId: basename(dir),
        err
      })
    })
    .finally(() => {
      if (appendChains.get(dir) === next) appendChains.delete(dir)
    })
  appendChains.set(dir, next)
  return next
}

export async function flushMessageAppends(dir?: string): Promise<void> {
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

/** @internal */
export function messageAppendChainSizeForTests(): number {
  return appendChains.size
}

export function resetMessageAppendQueueForTests(): void {
  appendChains.clear()
  lastErrors.clear()
  pendingNotices.clear()
}
