import { describe, expect, it } from 'vitest'
import { formatInteractiveRefs, parseBrowserTarget } from '@main/app/agentBrowserRefs'

describe('parseBrowserTarget', () => {
  it('parses @eN and eN refs', () => {
    expect(parseBrowserTarget('@e12')).toEqual({ kind: 'ref', id: 'e12' })
    expect(parseBrowserTarget('e3')).toEqual({ kind: 'ref', id: 'e3' })
    expect(parseBrowserTarget(' @E7 ')).toEqual({ kind: 'ref', id: 'e7' })
  })

  it('treats CSS selectors as css', () => {
    expect(parseBrowserTarget('button.submit')).toEqual({
      kind: 'css',
      selector: 'button.submit'
    })
    expect(parseBrowserTarget('#login')).toEqual({ kind: 'css', selector: '#login' })
  })
})

describe('formatInteractiveRefs', () => {
  it('formats empty and populated lists', () => {
    expect(formatInteractiveRefs([])).toBe('(no interactive elements found)')
    expect(
      formatInteractiveRefs([
        { id: 'e1', selector: '#go', tag: 'BUTTON', role: 'button', name: 'Go' }
      ])
    ).toContain('@e1 button "Go"')
  })
})
