import { useEffect, useRef } from 'react'
import type { ToolApprovalMode } from '@shared/ipc'
import { Button } from '@renderer/lib/ui'

const MODES: { mode: ToolApprovalMode; label: string; description: string }[] = [
  {
    mode: 'off',
    label: 'Off',
    description: 'Run tools without asking (current default).'
  },
  {
    mode: 'mutating',
    label: 'Mutating tools',
    description: 'Ask before file edits, terminal, and other mutating tools.'
  },
  {
    mode: 'all',
    label: 'All tools',
    description: 'Ask before every tool call, including reads.'
  }
]

export function ToolApprovalOnboardingModal({
  open,
  onChoose,
  onDismiss
}: {
  open: boolean
  onChoose: (mode: ToolApprovalMode) => void
  onDismiss: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  if (!open) return null

  return (
    <dialog
      ref={dialogRef}
      className="max-w-md rounded-2xl border border-border bg-surface p-0 text-fg shadow-xl backdrop:bg-black/40"
      onCancel={(e) => {
        e.preventDefault()
        onDismiss()
      }}
    >
      <div className="flex flex-col gap-3 p-5">
        <div>
          <h2 className="m-0 text-md font-semibold text-fg-strong">Tool approval</h2>
          <p className="m-0 mt-1 text-sm text-secondary">
            Choose whether Vyotiq should ask before the agent runs tools. You can change this
            anytime in Settings → Agent.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          {MODES.map((item) => (
            <button
              key={item.mode}
              type="button"
              className="rounded-xl border border-border bg-surface-2 px-3 py-2 text-left transition-colors hover:bg-surface"
              onClick={() => onChoose(item.mode)}
            >
              <div className="text-sm font-medium text-fg-strong">{item.label}</div>
              <div className="text-xs text-secondary">{item.description}</div>
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="subtle" onClick={onDismiss}>
            Not now
          </Button>
        </div>
      </div>
    </dialog>
  )
}
