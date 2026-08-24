import {
  packageScripts,
  preferPnpm,
  parseSafeCommand,
  resolveDiagnosticsBin,
  runSafeCommand
} from './diagnostics'
import { sanitizedTerminalEnv } from './terminal'
import { abortError } from '../../../shared/errors'

const TEST_TIMEOUT_MS = 300_000

export type RunTestsResult = { ok: boolean; command: string; content: string }

/**
 * Resolve what command to run: an explicit (sandboxed) command, a named package
 * script, or the workspace test script. Mirrors how `diagnostics` resolves its
 * command but defaults to the project's test runner.
 */
function resolveTestCommand(workspace: string, command?: string, script?: string): string {
  const override = (command ?? '').trim()
  if (override) return override
  const scripts = packageScripts(workspace)
  const pm = preferPnpm(workspace) ? 'pnpm' : 'npm'
  const named = (script ?? '').trim()
  if (named) return `${pm} run ${named}`
  if (scripts.test) return `${pm} run test`
  return `${pm} test`
}

export async function toolRunTestsAsync(
  workspace: string,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<RunTestsResult> {
  const command = resolveTestCommand(
    workspace,
    typeof args.command === 'string' ? args.command : undefined,
    typeof args.script === 'string' ? args.script : undefined
  )
  if (signal.aborted) throw abortError()

  let bin: string
  let argv: string[]
  try {
    ;({ bin, args: argv } = parseSafeCommand(command))
    bin = resolveDiagnosticsBin(workspace, bin)
  } catch (err) {
    return {
      ok: false,
      command,
      content: [`command: ${command}`, (err as Error).message].join('\n')
    }
  }

  try {
    const { stdout, stderr, exitCode, killed } = await runSafeCommand(bin, argv, {
      cwd: workspace,
      env: sanitizedTerminalEnv(),
      signal,
      timeoutMs: TEST_TIMEOUT_MS
    })
    if (signal.aborted) throw abortError()
    const output = [stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)'
    if (exitCode !== 0 && !killed) {
      return {
        ok: false,
        command,
        content: [`command: ${command}`, `exit: ${exitCode ?? 'error'}`, output]
          .filter(Boolean)
          .join('\n')
      }
    }
    if (killed) {
      return {
        ok: false,
        command,
        content: [
          `command: ${command}`,
          'Test command was killed (timeout or output too large)',
          output
        ]
          .filter(Boolean)
          .join('\n')
      }
    }
    return { ok: true, command, content: [`command: ${command}`, '', output].join('\n') }
  } catch (err) {
    if (signal.aborted) throw err
    return {
      ok: false,
      command,
      content: [`command: ${command}`, (err as Error).message ?? 'Test command failed'].join('\n')
    }
  }
}
