import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { buildSessionEnvSection } from '@main/agent/context/sessionEnv'

describe('buildSessionEnvSection', () => {
  it('includes UTC, local time with timezone, OS version, shell, and mode', () => {
    const section = buildSessionEnvSection('agent', 'powershell')
    expect(section).toMatch(/^## Session\n/)
    expect(section).toContain('Date (UTC):')
    expect(section).toMatch(/Date \(UTC\): \d{4}-\d{2}-\d{2}T/)
    expect(section).toContain('Date (local):')
    expect(section).toMatch(
      /Date \(local\): \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(.+, UTC[+-]\d{2}:\d{2}\)/
    )
    expect(section).toContain(`OS version: ${os.release()}`)
    expect(section).toContain('Terminal shell: powershell')
    expect(section).toContain('Interaction mode: agent')
    expect(section).toMatch(/OS: .+ \(/)
  })

  it('uses ask mode when requested', () => {
    const section = buildSessionEnvSection('ask', 'auto')
    expect(section).toContain('Interaction mode: ask')
  })
})
