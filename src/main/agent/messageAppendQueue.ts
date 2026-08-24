import { appendFile } from 'fs/promises'
import { basename, join } from 'path'
import { logger } from '../../shared/logger'
import {
  bumpFailure,
  formatAppendFailure,
  withTransientAppendRetry,
  type DirAppendFailures
} from './appendRetry'

/** Per-run-dir serialized message append chain — ordered, non-blocking. */
const appendChains = new Map<string, Promise<void>>()
/** Accumulated append failures per run dir, consumed by flushMessageAppends (throws). */
const failuresForFlush = new Map<string, DirAppendFailures>()
/**
 * Accumulated mid-run append failures per run dir, surfaced to the run as a
 * consumable notice. Reset only when the run reads the notice, so every batch of
 * failures (not just the first) is reported.
 */
const pendingNotices = new Map<string, DirAppendFailures>()

function recordAppendError(dir: string, err: unknown): void {
  bumpFailure(failuresForFlush, dir, err)
  bumpFailure(pendingNotices, dir, err)
}

function takeAppendError(dir: string): DirAppendFailures | undefined {
  const err = failuresForFlush.get(dir)
  if (err) failuresForFlush.delete(dir)
  return err
}

/** Consume the accumulated mid-run append failures for a run dir, if any. */
export function takeMessageAppendFailureNotice(dir: string): Error | undefined {
  const f = pendingNotices.get(dir)
  if (!f) return undefined
  pendingNotices.delete(dir)
  return formatAppendFailure('messages.jsonl', [f])
}

function throwIfAppendError(dir: string): void {
  const f = takeAppendError(dir)
  if (f) throw formatAppendFailure('messages.jsonl', [f])
}

export function enqueueMessageAppend(dir: string, line: string): Promise<void> {
  const path = join(dir, 'messages.jsonl')
  const prev = appendChains.get(dir) ?? Promise.resolve()
  const next = prev
    .then(() => withTransientAppendRetry(() => appendFile(path, line, 'utf8')))
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

/**
 * Serialize a whole-file rewrite behind queued appends. A read-modify-write that
 * races the chain would silently drop lines that were still buffered — including
 * the partial assistant message flushed on the terminal error paths.
 */
export function enqueueMessageRewrite(dir: string, rewrite: () => void): Promise<void> {
  const prev = appendChains.get(dir) ?? Promise.resolve()
  const next = prev
    .then(() => {
      rewrite()
    })
    .catch((err) => {
      recordAppendError(dir, err)
      logger.warn('Failed to rewrite messages.jsonl', {
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
    const f = failuresForFlush.get(dir)
    if (f) {
      failuresForFlush.delete(dir)
      throw formatAppendFailure('messages.jsonl', [f])
    }
    return
  }
  await Promise.all([...appendChains.values()])
  if (failuresForFlush.size === 0) return
  const all = [...failuresForFlush.values()]
  failuresForFlush.clear()
  throw formatAppendFailure('messages.jsonl', all)
}

/** @internal */
export function messageAppendChainSizeForTests(): number {
  return appendChains.size
}

export function resetMessageAppendQueueForTests(): void {
  appendChains.clear()
  failuresForFlush.clear()
  pendingNotices.clear()
}
