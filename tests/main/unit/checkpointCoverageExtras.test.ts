import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  beginWriteCheckpoint,
  finalizeWriteCheckpoint,
  resetWriteCheckpointsForTests,
  undoWrites
} from '@main/agent/checkpoints'
import { extractTerminalWritePaths, needsOpaqueWatch, recordTerminalCommandPriors } from '@main/agent/tools/terminalCheckpoint'
import { recordMcpFilesystemPriors, mcpFilesystemWriteToolsForTests } from '@main/agent/tools/mcpCheckpoint'
import {
  applyWatchDiffToCheckpoint,
  diffSince,
  disposeWatch,
  startWatch
} from '@main/agent/workspaceMutationWatch'

describe('terminalCheckpoint path parser', () => {
  it('extracts redirection and common mutator paths', () => {
    expect(extractTerminalWritePaths('echo hello > out.txt')).toContain('out.txt')
    expect(extractTerminalWritePaths('echo hi >> "logs/a.txt"')).toContain('logs/a.txt')
    expect(extractTerminalWritePaths('cp src/a.ts dest/b.ts')).toEqual(
      expect.arrayContaining(['src/a.ts', 'dest/b.ts'])
    )
    expect(extractTerminalWritePaths('rm -rf build/tmp')).toContain('build/tmp')
    expect(extractTerminalWritePaths('git restore -- src/x.ts')).toContain('src/x.ts')
    expect(extractTerminalWritePaths('echo hi > /dev/null')).not.toContain('/dev/null')
    expect(extractTerminalWritePaths('rm -rf dist/*')).toEqual([])
    expect(extractTerminalWritePaths(`Set-Content -Path 'out.ps1' -Value 'x'`)).toContain('out.ps1')
    expect(extractTerminalWritePaths('echo hi | tee log.txt')).toContain('log.txt')
  })

  it('needs opaque watch only for package managers and build runners', () => {
    expect(needsOpaqueWatch('node scripts/build.js')).toBe(false)
    expect(needsOpaqueWatch('python -c "print(1)"')).toBe(false)
    expect(needsOpaqueWatch('dir')).toBe(false)
    expect(needsOpaqueWatch('pnpm test')).toBe(true)
    expect(needsOpaqueWatch('pip install requests')).toBe(true)
    expect(needsOpaqueWatch('echo hello > out.txt')).toBe(false)
    expect(needsOpaqueWatch('cp src/a.ts dest/b.ts')).toBe(false)
  })

  it('records priors into the active checkpoint', () => {
    resetWriteCheckpointsForTests()
    const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-term-cp-'))
    const runDir = mkdtempSync(join(tmpdir(), 'vyotiq-term-run-'))
    try {
      writeFileSync(join(workspace, 'a.txt'), 'old\n', 'utf8')
      beginWriteCheckpoint(runDir, workspace)
      recordTerminalCommandPriors(workspace, 'echo new > a.txt', { runDir })
      writeFileSync(join(workspace, 'a.txt'), 'new\n', 'utf8')
      const meta = finalizeWriteCheckpoint(runDir)
      expect(meta!.files).toEqual([
        expect.objectContaining({ path: 'a.txt', action: 'modified', undoable: true })
      ])
      undoWrites(runDir, workspace, meta!.id)
      expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('old\n')
    } finally {
      resetWriteCheckpointsForTests()
      rmSync(workspace, { recursive: true, force: true })
      rmSync(runDir, { recursive: true, force: true })
    }
  })
})

describe('mcpCheckpoint known paths', () => {
  it('lists filesystem write tools', () => {
    expect(mcpFilesystemWriteToolsForTests()).toEqual(
      expect.arrayContaining(['write_file', 'edit_file', 'create_directory', 'move_file'])
    )
  })

  it('records write_file path before mutation', () => {
    resetWriteCheckpointsForTests()
    const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-cp-'))
    const runDir = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-run-'))
    try {
      writeFileSync(join(workspace, 'f.txt'), 'before\n', 'utf8')
      beginWriteCheckpoint(runDir, workspace)
      recordMcpFilesystemPriors(
        'filesystem',
        'write_file',
        { path: 'f.txt', content: 'after' },
        { runDir }
      )
      writeFileSync(join(workspace, 'f.txt'), 'after\n', 'utf8')
      const meta = finalizeWriteCheckpoint(runDir)
      expect(meta!.files[0]).toMatchObject({ path: 'f.txt', action: 'modified' })
      undoWrites(runDir, workspace, meta!.id)
      expect(readFileSync(join(workspace, 'f.txt'), 'utf8')).toBe('before\n')
    } finally {
      resetWriteCheckpointsForTests()
      rmSync(workspace, { recursive: true, force: true })
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('records move_file source as delete and destination as write', () => {
    resetWriteCheckpointsForTests()
    const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-mv-'))
    const runDir = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-mv-run-'))
    try {
      writeFileSync(join(workspace, 'src.txt'), 'body\n', 'utf8')
      beginWriteCheckpoint(runDir, workspace)
      recordMcpFilesystemPriors(
        'fs',
        'move_file',
        { source: 'src.txt', destination: 'dst.txt' },
        { runDir }
      )
      const meta = finalizeWriteCheckpoint(runDir)
      expect(meta!.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'src.txt', action: 'deleted' }),
          expect.objectContaining({ path: 'dst.txt', action: 'created' })
        ])
      )
    } finally {
      resetWriteCheckpointsForTests()
      rmSync(workspace, { recursive: true, force: true })
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('skips edit_file dryRun', () => {
    resetWriteCheckpointsForTests()
    const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-dry-'))
    const runDir = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-dry-run-'))
    try {
      writeFileSync(join(workspace, 'f.txt'), 'x\n', 'utf8')
      beginWriteCheckpoint(runDir, workspace)
      recordMcpFilesystemPriors(
        'filesystem',
        'edit_file',
        { path: 'f.txt', edits: [], dryRun: true },
        { runDir }
      )
      expect(finalizeWriteCheckpoint(runDir)).toBeNull()
    } finally {
      resetWriteCheckpointsForTests()
      rmSync(workspace, { recursive: true, force: true })
      rmSync(runDir, { recursive: true, force: true })
    }
  })
})

describe('workspaceMutationWatch', () => {
  let workspace: string
  let runDir: string

  beforeEach(() => {
    resetWriteCheckpointsForTests()
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-watch-ws-'))
    runDir = mkdtempSync(join(tmpdir(), 'vyotiq-watch-run-'))
    writeFileSync(join(workspace, 'keep.txt'), 'keep\n', 'utf8')
  })

  afterEach(() => {
    resetWriteCheckpointsForTests()
    rmSync(workspace, { recursive: true, force: true })
    rmSync(runDir, { recursive: true, force: true })
  })

  it('catches opaque creates and restores via discard', () => {
    beginWriteCheckpoint(runDir, workspace)
    const snap = startWatch(workspace)
    writeFileSync(join(workspace, 'opaque.txt'), 'secret\n', 'utf8')
    const diff = diffSince(snap)
    expect(diff.created).toContain('opaque.txt')
    applyWatchDiffToCheckpoint(snap, diff, { runDir })
    disposeWatch(snap)
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta!.files).toEqual([
      expect.objectContaining({ path: 'opaque.txt', action: 'created', undoable: true })
    ])
    undoWrites(runDir, workspace, meta!.id)
    expect(existsSync(join(workspace, 'opaque.txt'))).toBe(false)
  })

  it('restores modified files from snapshot blobs', () => {
    writeFileSync(join(workspace, 'm.txt'), 'before\n', 'utf8')
    beginWriteCheckpoint(runDir, workspace)
    const snap = startWatch(workspace)
    writeFileSync(join(workspace, 'm.txt'), 'after\n', 'utf8')
    const diff = diffSince(snap)
    expect(diff.modified).toContain('m.txt')
    applyWatchDiffToCheckpoint(snap, diff, { runDir })
    disposeWatch(snap)
    const meta = finalizeWriteCheckpoint(runDir)
    undoWrites(runDir, workspace, meta!.id)
    expect(readFileSync(join(workspace, 'm.txt'), 'utf8')).toBe('before\n')
  })

  it('records large modified files as non-undoable when no snapshot blob exists', () => {
    const largePath = join(workspace, 'big.bin')
    writeFileSync(largePath, Buffer.alloc(1_100_000, 1))
    beginWriteCheckpoint(runDir, workspace)
    const snap = startWatch(workspace)
    writeFileSync(largePath, Buffer.alloc(1_100_000, 2))
    const diff = diffSince(snap)
    expect(diff.modified).toContain('big.bin')
    applyWatchDiffToCheckpoint(snap, diff, { runDir })
    disposeWatch(snap)
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta!.files).toEqual([
      expect.objectContaining({ path: 'big.bin', action: 'modified', undoable: false })
    ])
  })
})
