/** Broken-pipe / reset writes must not cascade through uncaughtException logging. */
export function isIgnorablePipeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  return code === 'EPIPE' || code === 'ECONNRESET'
}
