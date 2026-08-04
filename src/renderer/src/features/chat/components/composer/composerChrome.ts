/**
 * Compact composer/toolbar chrome text.
 * Avoid truncate + leading-none on short labels — that clips Plus Jakarta Sans
 * descenders (g reads as q → “Aqent”).
 */
export const chromeLabelText =
  'text-xs leading-tight tracking-normal'

export const chromePillButton = [
  'inline-flex h-7 items-center rounded-md px-1',
  chromeLabelText,
  'bg-transparent border-0',
  'vy-transition hover:bg-surface hover:text-fg active:bg-surface',
  'disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]'
].join(' ')
