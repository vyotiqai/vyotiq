import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readGitDiff: vi.fn(),
  readGitLog: vi.fn(),
  readGitStatus: vi.fn(),
  streamChat: vi.fn()
}))

vi.mock('@main/git/git', () => ({
  readGitDiff: mocks.readGitDiff,
  readGitLog: mocks.readGitLog,
  readGitStatus: mocks.readGitStatus
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({
    provider: 'ollama',
    model: 'qwen2.5-coder',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    customOpenAiBaseUrl: 'http://127.0.0.1:8080/v1'
  })
}))

vi.mock('@main/settings/secrets', () => ({
  getSecret: () => null
}))

vi.mock('@main/workspace/workspaces', () => ({
  findWorkspaceSettingsOverride: () => null,
  readWorkspacesState: () => ({ settingsOverridesByPath: {} })
}))

vi.mock('@main/agent/providers', () => ({
  getProvider: () => ({
    id: 'ollama',
    listModels: async () => [],
    streamChat: mocks.streamChat
  })
}))

import { generateCommitMessage } from '@main/git/commitMessage'

describe('generateCommitMessage', () => {
  beforeEach(() => {
    mocks.readGitDiff.mockReset()
    mocks.readGitLog.mockReset()
    mocks.readGitStatus.mockReset()
    mocks.streamChat.mockReset()
    mocks.readGitDiff.mockResolvedValue({
      ok: true,
      content: 'diff --git a/src/tools/shell.ts b/src/tools/shell.ts\n+export function runShell() {}'
    })
    mocks.readGitStatus.mockResolvedValue({
      kind: 'ok',
      status: {
        branch: 'main',
        files: [
          {
            path: 'src/tools/shell.ts',
            status: 'added',
            added: 1,
            removed: 0,
            addedStaged: 0,
            removedStaged: 0,
            addedUnstaged: 1,
            removedUnstaged: 0,
            binary: false,
            staged: false,
            unstaged: true
          }
        ],
        truncated: false,
        fileCount: 1,
        added: 1,
        removed: 0,
        hasRemote: false,
        hasCommits: true
      }
    })
    mocks.readGitLog.mockResolvedValue([{ subject: 'feat(cli): add command runner' }])
  })

  it('sends the selected diff and recent history to the configured agent model', async () => {
    mocks.streamChat.mockImplementation(async function* (request: { messages: Array<{ content: string }> }) {
      expect(request.messages[0]?.content).toContain('src/tools/shell.ts')
      expect(request.messages[0]?.content).toContain('feat(cli): add command runner')
      yield { type: 'text', text: 'feat(cli): add shell execution helper' }
      yield { type: 'done' }
    })

    await expect(generateCommitMessage('/ws', 'all')).resolves.toEqual({
      message: 'feat(cli): add shell execution helper',
      source: 'agent'
    })
    expect(mocks.readGitDiff).toHaveBeenCalledTimes(1)
  })

  it('falls back without preventing commit when the provider returns an error', async () => {
    mocks.streamChat.mockImplementation(async function* () {
      yield { type: 'error', error: 'provider unavailable' }
    })

    await expect(generateCommitMessage('/ws', 'all')).resolves.toEqual({
      message: null,
      source: 'fallback'
    })
  })
})
