import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import { filterToolDefsForMode, isBuiltinAllowedInMode } from '@main/agent/tools/modePolicy'
import { AGENT_TOOLS } from '@main/agent/schemas/tools'
import { isApprovalExemptTool, isParallelSafeTool } from '@main/agent/tools/classify'

const getSettings = vi.hoisted(() =>
  vi.fn(() => ({ ...DEFAULT_SETTINGS, autoModeSwitch: true }))
)

vi.mock('@main/settings/settings', () => ({
  getSettings: () => getSettings()
}))

import { executeTool } from '@main/agent/tools'

describe('switch_mode', () => {
  beforeEach(() => {
    getSettings.mockReset()
    getSettings.mockReturnValue({ ...DEFAULT_SETTINGS, autoModeSwitch: true })
  })

  it('is allowed in every interaction mode when autoModeSwitch is on', () => {
    const opts = { autoModeSwitch: true }
    expect(isBuiltinAllowedInMode('ask', 'switch_mode', opts)).toBe(true)
    expect(isBuiltinAllowedInMode('plan', 'switch_mode', opts)).toBe(true)
    expect(isBuiltinAllowedInMode('agent', 'switch_mode', opts)).toBe(true)
  })

  it('is denied in every interaction mode when autoModeSwitch is off', () => {
    expect(isBuiltinAllowedInMode('ask', 'switch_mode')).toBe(false)
    expect(isBuiltinAllowedInMode('plan', 'switch_mode', { autoModeSwitch: false })).toBe(false)
    expect(isBuiltinAllowedInMode('agent', 'switch_mode', { autoModeSwitch: false })).toBe(false)
  })

  it('is serial and approval-exempt', () => {
    expect(isParallelSafeTool('switch_mode')).toBe(false)
    expect(isApprovalExemptTool('switch_mode')).toBe(true)
    expect(isParallelSafeTool('ask_question')).toBe(false)
    expect(isApprovalExemptTool('ask_question')).toBe(true)
  })

  it('updates mutable mode and emits mode_changed when autoModeSwitch is on', async () => {
    let mode: 'ask' | 'plan' | 'agent' = 'ask'
    const events: { type: string; mode?: string }[] = []
    const result = await executeTool(
      'switch_mode',
      JSON.stringify({ mode: 'agent' }),
      '/ws',
      new AbortController().signal,
      {
        runId: 'run-1',
        toolCallId: 'tc-1',
        getAgentMode: () => mode,
        setAgentMode: (next) => {
          mode = next
        },
        emitAgentEvent: (ev) => events.push(ev),
        autoModeSwitch: true
      }
    )
    expect(result.ok).toBe(true)
    expect(mode).toBe('agent')
    expect(events[0]?.type).toBe('mode_changed')
    expect(events[0]).toMatchObject({ type: 'mode_changed', runId: 'run-1', mode: 'agent' })
  })

  it('fails execute when autoModeSwitch is off', async () => {
    getSettings.mockReturnValue({ ...DEFAULT_SETTINGS, autoModeSwitch: false })
    let mode: 'ask' | 'plan' | 'agent' = 'ask'
    const result = await executeTool(
      'switch_mode',
      JSON.stringify({ mode: 'agent' }),
      '/ws',
      new AbortController().signal,
      {
        runId: 'run-1',
        toolCallId: 'tc-1',
        getAgentMode: () => mode,
        setAgentMode: (next) => {
          mode = next
        },
        autoModeSwitch: false
      }
    )
    expect(result.ok).toBe(false)
    expect(mode).toBe('ask')
    expect(result.content).toMatch(/Automatic mode switching is off/i)
  })

  it('re-filters tool defs after mode change when autoModeSwitch is on', () => {
    const opts = { autoModeSwitch: true }
    const askTools = filterToolDefsForMode('ask', AGENT_TOOLS, opts).map((t) => t.name)
    expect(askTools).toContain('ask_question')
    expect(askTools).toContain('switch_mode')
    expect(askTools).not.toContain('edit')

    const agentTools = filterToolDefsForMode('agent', AGENT_TOOLS, opts).map((t) => t.name)
    expect(agentTools).toContain('edit')
    expect(agentTools).toContain('ask_question')
    expect(agentTools).toContain('switch_mode')
  })

  it('omits switch_mode from tool defs when autoModeSwitch is off', () => {
    const askTools = filterToolDefsForMode('ask', AGENT_TOOLS).map((t) => t.name)
    expect(askTools).not.toContain('switch_mode')
    const agentTools = filterToolDefsForMode('agent', AGENT_TOOLS, {
      autoModeSwitch: false
    }).map((t) => t.name)
    expect(agentTools).not.toContain('switch_mode')
    expect(agentTools).toContain('edit')
  })
})
