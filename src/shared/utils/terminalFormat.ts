export type ParsedTerminalOutput = {
  cwd: string
  stdout: string
  stderr: string
  exitCode: number | null
}

/** Strip cwd/shell headers injected by toolTerminal before parsing exit metadata. */
export function stripTerminalCwdHeader(content: string): string {
  return content.replace(/^cwd:.*\n(?:shell:.*\n)?\n?/m, '')
}

/**
 * Parse only a trailing `exit_code: N` line (not literal output that happens to
 * contain the same text earlier in stdout/stderr).
 */
function takeTrailingExitCode(text: string): { body: string; exitCode: number | null } {
  const match = text.match(/\nexit_code:\s*(-?\d+)\s*$/) ?? text.match(/^exit_code:\s*(-?\d+)\s*$/)
  if (!match || match.index == null) return { body: text, exitCode: null }
  return {
    body: text.slice(0, match.index).replace(/\s+$/, ''),
    exitCode: Number(match[1])
  }
}

/**
 * Parse terminal tool result text into cwd, streams, and exit code.
 *
 * Format: `cwd: …`, optional stdout, optional `stderr:\n…`, trailing `exit_code: N`.
 */
export function parseTerminalOutput(content: string): ParsedTerminalOutput {
  const cwdMatch = content.match(/^cwd:\s*(.+)$/m)
  const cwd = cwdMatch?.[1]?.trim() ?? ''

  const body = stripTerminalCwdHeader(content)
  const { body: withoutExit, exitCode } = takeTrailingExitCode(body)

  let stderr = ''
  let stdout = withoutExit
  if (withoutExit.startsWith('stderr:\n')) {
    stdout = ''
    stderr = withoutExit.slice('stderr:\n'.length).replace(/\s+$/, '')
  } else {
    const marker = '\nstderr:\n'
    const stderrIdx = withoutExit.indexOf(marker)
    if (stderrIdx >= 0) {
      stdout = withoutExit.slice(0, stderrIdx).replace(/\s+$/, '')
      stderr = withoutExit.slice(stderrIdx + marker.length).replace(/\s+$/, '')
    }
  }

  return { cwd, stdout, stderr, exitCode }
}
