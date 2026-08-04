import { describe, expect, it } from 'vitest'
import {
  finalizeInterruptedTodoContent,
  todoContentHasInProgress
} from '@shared/utils/todoContent'

describe('todoContent', () => {
  it('detects in-progress checklist markers', () => {
    expect(todoContentHasInProgress('0/2 complete\n[ ] One\n[~] Two')).toBe(true)
    expect(todoContentHasInProgress('0/2 complete\n[ ] One\n[-] Two')).toBe(false)
  })

  it('demotes in-progress tasks to cancelled', () => {
    expect(
      finalizeInterruptedTodoContent(
        '0/5 complete\n[~] Audit core library files\n[ ] Audit API routes'
      )
    ).toBe('0/5 complete\n[-] Audit core library files\n[ ] Audit API routes')
  })
})
