import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/ipc'

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({ ...DEFAULT_SETTINGS })
}))

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import {
  decodeConsoleText,
  isCommandProbeNoTarget,
  isCommandProbeNoTargetContent,
  isElevationDenied,
  isElevationDeniedContent,
  formatTerminalSessionOutput
} from '@main/agent/tools/terminal'
import { terminalResultOk } from '@main/agent/tools'
import { nextConsecutiveToolFailureSteps } from '@main/agent/loopPolicy'
import type { ChatMessage } from '@shared/ipc'

/**
 * Fixtures are the verbatim outcomes from run 1de9344a (Aether OS build,
 * 2026-08-30): four consecutive terminal "failures" — three informative
 * answers plus one declined UAC prompt — stopped the run via LOOP_SAFETY.
 */

const utf16Stderr = (text: string): Buffer => {
  const le = Buffer.from(text, 'utf16le')
  return Buffer.concat([Buffer.from([0xff, 0xfe]), le])
}

describe('decodeConsoleText', () => {
  it('decodes UTF-16LE stderr (wsl.exe redirected output) into readable text', () => {
    const buf = utf16Stderr('The Windows Subsystem for Linux is not installed.')
    const text = decodeConsoleText(buf)
    expect(text).toBe('The Windows Subsystem for Linux is not installed.')
    expect(text).not.toContain('\u0000')
  })

  it('decodes BOM-less UTF-16LE', () => {
    expect(decodeConsoleText(Buffer.from('wsl: not installed', 'utf16le'))).toBe(
      'wsl: not installed'
    )
  })

  it('keeps plain UTF-8 untouched', () => {
    const buf = Buffer.from('podman : The term is not recognized\nsecond line', 'utf8')
    expect(decodeConsoleText(buf)).toBe('podman : The term is not recognized\nsecond line')
  })

  it('strips stray NULs from printable output — byte-identical minus the NULs', () => {
    // A NUL is never part of a multi-byte UTF-8 sequence, so stripping is safe
    // for any NUL-bearing printable chunk regardless of the two-NUL signature.
    const buf = Buffer.concat([Buffer.from([0x00, 0x41]), Buffer.from('plain', 'utf8')])
    expect(decodeConsoleText(buf)).toBe('Aplain')
  })

  it('keeps non-printable binary noise on the original UTF-8 decode (never worse)', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03, 0x07, 0x00, 0x1f, 0x0b, 0x00])
    expect(decodeConsoleText(buf)).toBe(buf.toString('utf8'))
  })

  it('repairs a MIXED stream: ASCII prefix + UTF-16LE body (real wsl.exe capture shape)', () => {
    // Verbatim shape from the 2026-08-30 raw byte capture of `wsl --status 2>&1`
    // stderr: 77 73 6c 20 3a 20 ("wsl : ") then UTF-16LE payload.
    const buf = Buffer.concat([
      Buffer.from('wsl : ', 'utf8'),
      Buffer.from('The Windows Subsystem for Linux is not installed.', 'utf16le')
    ])
    const text = decodeConsoleText(buf)
    expect(text).toBe('wsl : The Windows Subsystem for Linux is not installed.')
    expect(text).not.toContain('\u0000')
  })

  it('leaves BOM-less NUL-free UTF-16 (CJK-only) untouched — byte-ambiguous with UTF-8', () => {
    // No BOM, no NUL signature: re-decoding would corrupt genuine UTF-8 CJK
    // output (real git-log CJK paths), so this deliberately stays UTF-8.
    const buf = Buffer.from('日本語テスト', 'utf16le')
    expect(decodeConsoleText(buf)).toBe(buf.toString('utf8'))
  })
})

describe('isCommandProbeNoTarget', () => {
  it('classifies a --version probe hitting a missing command as informative', () => {
    const stderr = `podman : The term 'podman' is not recognized as the name of a cmdlet, function, script file, or operable program.`
    expect(
      isCommandProbeNoTarget('podman --version 2>&1; docker --version 2>&1', 1, '', stderr)
    ).toBe(true)
  })

  it('classifies a --status probe answered with "is not installed"', () => {
    expect(
      isCommandProbeNoTarget('wsl --status 2>&1; wsl -l -v 2>&1', 1, '', 'wsl: not installed')
    ).toBe(false)
    expect(
      isCommandProbeNoTarget('wsl --status 2>&1', 50, '', 'WSL is not installed on this machine.')
    ).toBe(true)
  })

  it('never treats a PowerShell parse error as a probe answer', () => {
    const stderr = "The term '=' is not recognized as the name of a cmdlet"
    expect(isCommandProbeNoTarget('podman --version 2>&1', 1, '', stderr)).toBe(false)
  })

  it('ignores non-zero exits from non-probe commands', () => {
    expect(isCommandProbeNoTarget('cargo test --release', 101, '', 'error: could not compile')).toBe(
      false
    )
    expect(isCommandProbeNoTarget('pnpm run lint', 1, '', 'oops')).toBe(false)
  })

  it('ignores zero and null exit codes', () => {
    expect(isCommandProbeNoTarget('podman --version', 0, 'podman version 4.0', '')).toBe(false)
    expect(isCommandProbeNoTarget('podman --version', null, '', '')).toBe(false)
  })

  it('classifies real probe content through the terminal frame (content parser)', () => {
    const content = [
      'cwd: C:\\machine\\ws',
      'shell: powershell',
      '',
      '',
      "stderr:\npodman : The term 'podman' is not recognized as the name of a cmdlet, function, script file, or operable program.",
      'exit_code: 1'
    ].join('\n')
    expect(isCommandProbeNoTargetContent('podman --version 2>&1', content)).toBe(true)
    expect(terminalResultOk('podman --version 2>&1', content)).toBe(true)
  })

  it('classifies through a session-poll frame using the header command', () => {
    const content = formatTerminalSessionOutput({
      cwd: 'C:\\ws',
      command: 'podman --version 2>&1',
      shell: 'powershell',
      stdout: '',
      stderr:
        "podman : The term 'podman' is not recognized as the name of a cmdlet, function, script file, or operable program.",
      exitCode: 1,
      sessionId: 'sess-1',
      status: 'done'
    })
    expect(isCommandProbeNoTargetContent('session', content)).toBe(true)
    expect(terminalResultOk('session', content)).toBe(true)
  })
})

describe('isElevationDenied', () => {
  it('classifies the winget administrator-privileges denial', () => {
    expect(
      isElevationDenied(
        'winget install --id Microsoft.WSL --silent',
        1,
        'Installer failed with exit code: 0x80073d28 : The package installation failed because administrator privileges are required.',
        ''
      )
    ).toBe(true)
  })

  it('classifies a declined UAC prompt (Start-Process -Verb RunAs)', () => {
    expect(
      isElevationDenied(
        'Start-Process powershell -Verb RunAs -Wait',
        1,
        '',
        'Start-Process : This command cannot be run due to the error: The operation was canceled by the user.'
      )
    ).toBe(true)
  })

  it('matches on the raw hex code alone', () => {
    expect(isElevationDenied('winget install X', -2147009240, 'exit=0x80073d28', '')).toBe(true)
  })

  it('does not swallow generic access denied or real failures', () => {
    expect(isElevationDenied('git push origin main', 128, '', 'remote: Access denied')).toBe(false)
    expect(isElevationDenied('cargo test --release', 101, 'error: could not compile', '')).toBe(
      false
    )
  })

  it('classifies through the terminal frame and via terminalResultOk', () => {
    const content = [
      'cwd: C:\\ws',
      'shell: powershell',
      '',
      "stderr:\nStart-Process : This command cannot be run due to the error: The operation was canceled by the user.",
      'exit_code: 1'
    ].join('\n')
    expect(isElevationDeniedContent('Start-Process -Verb RunAs', content)).toBe(true)
    expect(terminalResultOk('Start-Process -Verb RunAs', content)).toBe(true)
  })
})

describe('terminalResultOk (barrel wiring)', () => {
  it('both import paths classify the same', () => {
    const probe =
      'cwd: w\nshell: powershell\n\nstderr:\npodman : The term \'podman\' is not recognized as the name of a cmdlet\nexit_code: 1'
    const ok = 'cwd: w\nshell: powershell\n\nexit_code: 0'
    const realFail =
      'cwd: w\nshell: powershell\n\nstderr:\nerror: could not compile\nexit_code: 101'
    expect(terminalResultOk('podman --version', probe)).toBe(true)
    expect(terminalResultOk('podman --version', ok)).toBe(true)
    expect(terminalResultOk('cargo test', realFail)).toBe(false)
  })

  it('real build failures still count as failures', () => {
    const content =
      'cwd: w\nshell: powershell\n\nstderr:\nerror[E0308]: mismatched types\nexit_code: 101'
    expect(terminalResultOk('cargo test --release', content)).toBe(false)
  })
})

function toolMsg(content: string, ok: boolean, toolName = 'terminal'): ChatMessage {
  return {
    role: 'tool',
    toolCallId: 'c1',
    toolName,
    ok,
    content
  } as unknown as ChatMessage
}

describe('nextConsecutiveToolFailureSteps', () => {
  it('mixed step (success + failure) resets the streak — the documented all-failed contract', () => {
    const step = [toolMsg('10 tasks', true, 'todo_write'), toolMsg('probe failed', false)]
    expect(nextConsecutiveToolFailureSteps(3, step)).toBe(0)
  })

  it('all-failed step extends the streak', () => {
    const step = [toolMsg('err a', false), toolMsg('err b', false)]
    expect(nextConsecutiveToolFailureSteps(2, step)).toBe(3)
  })

  it('all-ok step resets the streak', () => {
    expect(nextConsecutiveToolFailureSteps(3, [toolMsg('fine', true)])).toBe(0)
  })

  it('abort/interrupt stubs are not tool results — a stub-only step resets', () => {
    expect(nextConsecutiveToolFailureSteps(2, [toolMsg('Cancelled', false)])).toBe(0)
    expect(nextConsecutiveToolFailureSteps(2, [toolMsg('Interrupted', false)])).toBe(0)
  })

  it('ignores non-tool messages', () => {
    const step = [
      { role: 'assistant', content: 'text' },
      toolMsg('err', false)
    ] as unknown as ChatMessage[]
    expect(nextConsecutiveToolFailureSteps(1, step)).toBe(2)
  })

  it('empty step output resets (no evidence of failure)', () => {
    expect(nextConsecutiveToolFailureSteps(2, [])).toBe(0)
  })

  it('streak reaching 4 still stops via loopStopDecision — genuinely stuck runs stop', () => {
    const step = [toolMsg('err', false)]
    let streak = 0
    for (let i = 0; i < 4; i++) streak = nextConsecutiveToolFailureSteps(streak, step)
    expect(streak).toBe(4)
  })
})
