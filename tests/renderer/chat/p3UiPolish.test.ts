/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildComposerSendProps,
  useSuppressedChatError
} from '@renderer/features/chat/hooks/composerShared'
import type { UiItem } from '@shared/transcript'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import { resolveEffectiveSettings } from '@shared/effectiveSettings'

const root = join(__dirname, '../../../src/renderer/src')

describe('P3 surfaceKey + composer shared hooks', () => {
  it('aligns SessionChatColumn surfaceKey with ChatView (no activeRunId)', () => {
    const chatView = readFileSync(join(root, 'features/chat/ChatView.tsx'), 'utf8')
    const column = readFileSync(join(root, 'features/chat/SessionChatColumn.tsx'), 'utf8')

    expect(chatView).toMatch(
      /surfaceKey = `\$\{workspacePath \?\? 'none'\}:\$\{chatSurfaceEpoch\}`/
    )
    expect(column).toMatch(
      /surfaceKey = `\$\{workspacePath \?\? 'none'\}:\$\{chatSurfaceEpoch\}`/
    )
    expect(column).not.toMatch(/activeRunId \?\? 'draft'/)
  })

  it('useSuppressedChatError clears banner when transcript has run_error', () => {
    const withRunError: UiItem[] = [
      { kind: 'run_error', id: 'e1', message: 'boom' }
    ]
    expect(useSuppressedChatError(withRunError, 'composer boom')).toBeNull()
    expect(useSuppressedChatError([], 'composer boom')).toBe('composer boom')
  })

  it('buildComposerSendProps mirrors shared dock fields', () => {
    const chatSettings = resolveEffectiveSettings(DEFAULT_SETTINGS, null)
    const props = buildComposerSendProps({
      provider: 'openai',
      model: 'gpt-4.1',
      running: false,
      hasWorkspace: true,
      hasTranscript: true,
      workspacePath: '/ws',
      onProviderModel: () => undefined,
      chatSettings,
      onChatSettingsChange: () => undefined,
      onSend: () => true,
      onStop: () => undefined,
      bannerError: null,
      secondaryBannerError: null,
      activeRunId: 'run-1'
    })
    expect(props.disabled).toBe(false)
    expect(props.hasTranscript).toBe(true)
    expect(props.onRetryNetwork).toBeUndefined()
    expect(props.bannerError).toBeNull()
    expect(props.activeRunId).toBe('run-1')
  })

  it('App wires pane compact + changes handlers into SessionChatColumn', () => {
    const app = readFileSync(join(root, 'app/App.tsx'), 'utf8')
    expect(app).toMatch(/onCompactContext=\{paneCompact\}/)
    expect(app).toMatch(/onOpenUncommittedChanges=\{onOpenUncommittedChanges\}/)
    expect(app).toMatch(/onOpenChanges=\{onOpenChanges\}/)
  })
})
