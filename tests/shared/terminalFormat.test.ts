import { describe, expect, it } from 'vitest'
import { parseTerminalOutput, sanitizeTerminalDisplayText } from '@shared/utils/terminalFormat'

describe('parseTerminalOutput', () => {
  it('splits cwd, stdout, stderr, and exit code', () => {
    const parsed = parseTerminalOutput(
      'cwd: /ws\n\nbuild output\nstderr:\nerror line\nexit_code: 1'
    )
    expect(parsed.cwd).toBe('/ws')
    expect(parsed.stdout).toContain('build output')
    expect(parsed.stderr).toContain('error line')
    expect(parsed.exitCode).toBe(1)
  })

  it('handles stdout-only success', () => {
    const parsed = parseTerminalOutput('cwd: /ws\n\nok\nexit_code: 0')
    expect(parsed.stdout).toBe('ok')
    expect(parsed.stderr).toBe('')
    expect(parsed.exitCode).toBe(0)
  })

  it('leaves literal exit_code text in stdout when it is not trailing metadata', () => {
    const parsed = parseTerminalOutput(
      'cwd: /ws\n\nnote exit_code: 9 in the log\nmore output\nexit_code: 0'
    )
    expect(parsed.stdout).toContain('note exit_code: 9 in the log')
    expect(parsed.exitCode).toBe(0)
  })
})

describe('sanitizeTerminalDisplayText', () => {
  it('strips ANSI color codes', () => {
    const esc = String.fromCharCode(0x1b)
    const raw = `${esc}[38;2;255;255;255mmodel.safetensors${esc}[0m`
    expect(sanitizeTerminalDisplayText(raw)).toBe('model.safetensors')
  })

  it('applies carriage-return overwrite per line', () => {
    const raw = 'Downloading 10%\rDownloading 50%\rDownloading 100%\nDone'
    expect(sanitizeTerminalDisplayText(raw)).toBe('Downloading 100%\nDone')
  })

  it('preserves Format-Table rows after stripping escapes', () => {
    const esc = String.fromCharCode(0x1b)
    const raw = `Name    SizeGB\n----    ------\n${esc}[32mmodel.safetensors${esc}[0m  1.23`
    expect(sanitizeTerminalDisplayText(raw)).toBe(
      'Name    SizeGB\n----    ------\nmodel.safetensors  1.23'
    )
  })
})
