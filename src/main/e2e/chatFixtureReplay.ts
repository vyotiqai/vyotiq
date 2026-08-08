import { readFileSync } from 'fs'
import { join } from 'path'
import type { AgentEvent } from '../../shared/ipc'
import { isAbortError } from '../../shared/errors'
import { clearRunAbort, streamSignalFor } from '../agent/runRegistry'

type FixtureFile = {
  events: unknown[]
}

const FIXTURE_REL = join('tests', 'gui-e2e', 'fixtures', 'chat-send-stream.json')

export function isChatFixtureReplayEnabled(): boolean {
  // Vitest sets VITEST=true; never hijack chatStart during unit/integration runs
  // even if VYOTIQ_E2E_FIXTURE leaked into the shell from a prior gui-e2e launch.
  if (process.env.VITEST === 'true') return false
  return process.env.VYOTIQ_E2E_FIXTURE === '1'
}

function loadFixtureTemplates(): Omit<AgentEvent, 'runId' | 'invokeId'>[] {
  const fixturePath = join(process.cwd(), FIXTURE_REL)
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as FixtureFile
  if (!Array.isArray(raw.events) || raw.events.length === 0) {
    throw new Error(`Fixture ${fixturePath} must contain a non-empty events array`)
  }
  return raw.events.map((event, index) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error(`Fixture event ${index} must be an object`)
    }
    const type = (event as { type?: unknown }).type
    if (typeof type !== 'string' || !type) {
      throw new Error(`Fixture event ${index} missing type`)
    }
    return event as Omit<AgentEvent, 'runId' | 'invokeId'>
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Replays recorded chat:event payloads for GUI e2e (VYOTIQ_E2E_FIXTURE=1).
 * Skips runAgent / live LLM while exercising the renderer stream path.
 */
export async function* replayChatFixture(input: {
  runId: string
  invokeId: number
  workspacePath: string
  runSignal: AbortSignal
}): AsyncGenerator<AgentEvent> {
  const signal = streamSignalFor(input.runId, input.runSignal)
  try {
    const templates = loadFixtureTemplates()
    for (const template of templates) {
      if (signal.aborted) {
        const err = new Error('Aborted')
        err.name = 'AbortError'
        throw err
      }
      const event = {
        ...template,
        runId: input.runId,
        invokeId: input.invokeId
      } as AgentEvent
      if (event.type === 'text_delta') {
        await sleep(8)
      }
      yield event
      if (signal.aborted) {
        const err = new Error('Aborted')
        err.name = 'AbortError'
        throw err
      }
    }
  } catch (err) {
    if (isAbortError(err)) {
      yield { type: 'status', runId: input.runId, invokeId: input.invokeId, status: 'cancelled' }
      return
    }
    throw err
  } finally {
    clearRunAbort(input.runId, input.invokeId)
  }
}
