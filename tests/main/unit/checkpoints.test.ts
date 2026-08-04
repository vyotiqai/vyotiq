import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  beginWriteCheckpoint,
  discardWriteCheckpoint,
  finalizeWriteCheckpoint,
  getWriteCheckpoint,
  getWriteCheckpointMeta,
  resetWriteCheckpointsForTests,
  undoWrites,
  resolveWrites,
  rewindWritesFrom
} from '@main/agent/checkpoints'
import { executeTool } from '@main/agent/tools'

let workspace: string
let runDir: string

beforeEach(() => {
  resetWriteCheckpointsForTests()
  workspace = mkdtempSync(join(tmpdir(), 'vyotiq-cp-ws-'))
  runDir = mkdtempSync(join(tmpdir(), 'vyotiq-cp-run-'))
  writeFileSync(join(workspace, 'a.txt'), 'hello\n', 'utf8')
})

afterEach(() => {
  resetWriteCheckpointsForTests()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(runDir, { recursive: true, force: true })
})

describe('write checkpoints', () => {
  it('snapshots priors and restores via undo', async () => {
    beginWriteCheckpoint(runDir, workspace)
    const signal = new AbortController().signal
    const result = await executeTool(
      'str_replace',
      JSON.stringify({ path: 'a.txt', old_string: 'hello', new_string: 'world' }),
      workspace,
      signal,
      { runDir }
    )
    expect(result.ok).toBe(true)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('world\n')

    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta).toBeTruthy()
    expect(meta!.files).toEqual([
      { path: 'a.txt', action: 'modified', undoable: true }
    ])

    const undone = undoWrites(runDir, workspace, meta!.id)
    expect(undone.restored).toEqual(['a.txt'])
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello\n')
  })

  it('undoes created files by deleting them', async () => {
    beginWriteCheckpoint(runDir, workspace)
    const signal = new AbortController().signal
    await executeTool(
      'edit',
      JSON.stringify({ path: 'new.txt', contents: 'fresh\n' }),
      workspace,
      signal,
      { runDir }
    )
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta!.files[0]?.action).toBe('created')
    expect(existsSync(join(workspace, 'new.txt'))).toBe(true)

    undoWrites(runDir, workspace)
    expect(existsSync(join(workspace, 'new.txt'))).toBe(false)
  })

  it('keeps first prior when the same path is written twice', () => {
    const cp = beginWriteCheckpoint(runDir, workspace)
    cp.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'mid\n', 'utf8')
    cp.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'end\n', 'utf8')
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta!.files).toHaveLength(1)
    undoWrites(runDir, workspace, meta!.id)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello\n')
  })

  it('marks recursive directory deletes as non-undoable', () => {
    mkdirSync(join(workspace, 'dir'), { recursive: true })
    writeFileSync(join(workspace, 'dir', 'x.txt'), 'x', 'utf8')
    const cp = beginWriteCheckpoint(runDir, workspace)
    cp.recordPrior('dir', 'delete', { recursiveDir: true })
    const meta = cp.finalize()
    discardWriteCheckpoint(runDir)
    expect(meta!.files[0]).toMatchObject({
      path: 'dir',
      action: 'deleted',
      undoable: false
    })
  })

  it('getWriteCheckpoint is empty without begin', () => {
    expect(getWriteCheckpoint(runDir)).toBeUndefined()
  })

  it('discards one path and keeps another', () => {
    writeFileSync(join(workspace, 'b.txt'), 'beta\n', 'utf8')
    const cp = beginWriteCheckpoint(runDir, workspace)
    cp.recordPrior('a.txt', 'write')
    cp.recordPrior('b.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'A\n', 'utf8')
    writeFileSync(join(workspace, 'b.txt'), 'B\n', 'utf8')
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta!.files).toHaveLength(2)

    const discarded = resolveWrites(runDir, workspace, {
      checkpointId: meta!.id,
      action: 'discard',
      paths: ['a.txt']
    })
    expect(discarded.discarded).toEqual(['a.txt'])
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello\n')
    expect(readFileSync(join(workspace, 'b.txt'), 'utf8')).toBe('B\n')

    const kept = resolveWrites(runDir, workspace, {
      checkpointId: meta!.id,
      action: 'keep',
      paths: ['b.txt']
    })
    expect(kept.kept).toEqual(['b.txt'])
    expect(kept.fullyResolved).toBe(true)
    expect(readFileSync(join(workspace, 'b.txt'), 'utf8')).toBe('B\n')
  })

  it('keep all resolves without touching disk', () => {
    const cp = beginWriteCheckpoint(runDir, workspace)
    cp.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'changed\n', 'utf8')
    const meta = finalizeWriteCheckpoint(runDir)
    const result = resolveWrites(runDir, workspace, {
      checkpointId: meta!.id,
      action: 'keep'
    })
    expect(result.kept).toEqual(['a.txt'])
    expect(result.fullyResolved).toBe(true)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('changed\n')
  })

  it('auto-keeps prior unresolved checkpoint when a newer write turn finalizes', () => {
    const first = beginWriteCheckpoint(runDir, workspace)
    first.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'turn1\n', 'utf8')
    const meta1 = finalizeWriteCheckpoint(runDir)
    expect(meta1).not.toBeNull()

    writeFileSync(join(workspace, 'b.txt'), 'seed\n', 'utf8')
    const second = beginWriteCheckpoint(runDir, workspace)
    second.recordPrior('b.txt', 'write')
    writeFileSync(join(workspace, 'b.txt'), 'turn2\n', 'utf8')
    const meta2 = finalizeWriteCheckpoint(runDir)
    expect(meta2).not.toBeNull()

    // Prior turn is no longer actionable.
    expect(() =>
      resolveWrites(runDir, workspace, { checkpointId: meta1!.id, action: 'discard' })
    ).toThrow(/already resolved/)
    // Disk from turn 1 remains (auto-keep, not discard).
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('turn1\n')
    // Latest turn still actionable.
    const discarded = resolveWrites(runDir, workspace, {
      checkpointId: meta2!.id,
      action: 'discard',
      paths: ['b.txt']
    })
    expect(discarded.discarded).toEqual(['b.txt'])
    expect(readFileSync(join(workspace, 'b.txt'), 'utf8')).toBe('seed\n')
  })

  it('rewindWritesFrom restores multi-turn writes newest-first including UI-kept', () => {
    writeFileSync(join(workspace, 'b.txt'), 'b0\n', 'utf8')

    const first = beginWriteCheckpoint(runDir, workspace, 0)
    first.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'a1\n', 'utf8')
    const meta1 = finalizeWriteCheckpoint(runDir)
    expect(meta1?.anchorUserMessageIndex).toBe(0)

    const second = beginWriteCheckpoint(runDir, workspace, 2)
    second.recordPrior('a.txt', 'write')
    second.recordPrior('b.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'a2\n', 'utf8')
    writeFileSync(join(workspace, 'b.txt'), 'b2\n', 'utf8')
    const meta2 = finalizeWriteCheckpoint(runDir)
    expect(meta2?.anchorUserMessageIndex).toBe(2)

    // Auto-keep made meta1 non-undoable via resolveWrites; rewind still restores.
    expect(getWriteCheckpointMeta(runDir, meta1!.id)?.resolved).toBe(true)

    const result = rewindWritesFrom(runDir, workspace, 2)
    expect(result.checkpointIds).toEqual([meta2!.id])
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('a1\n')
    expect(readFileSync(join(workspace, 'b.txt'), 'utf8')).toBe('b0\n')

    const resultEarlier = rewindWritesFrom(runDir, workspace, 0)
    expect(resultEarlier.checkpointIds).toContain(meta1!.id)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello\n')
  })

  it('rewind restores concurrent tool writes recorded on the same runDir checkpoint', async () => {
    // Multiple edits in one invoke share the parent's active InvokeWriteCheckpoint session.
    beginWriteCheckpoint(runDir, workspace, 0)
    const signal = new AbortController().signal
    const parentEdit = await executeTool(
      'edit',
      JSON.stringify({ path: 'a.txt', contents: 'parent\n' }),
      workspace,
      signal,
      { runDir }
    )
    expect(parentEdit.ok).toBe(true)

    const nestedEdit = await executeTool(
      'edit',
      JSON.stringify({ path: 'sub.txt', contents: 'from-sibling\n' }),
      workspace,
      signal,
      { runDir }
    )
    expect(nestedEdit.ok).toBe(true)
    expect(existsSync(join(workspace, 'sub.txt'))).toBe(true)

    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta?.anchorUserMessageIndex).toBe(0)
    expect(meta?.files.map((f) => f.path).sort()).toEqual(['a.txt', 'sub.txt'])

    const rewound = rewindWritesFrom(runDir, workspace, 0)
    expect(rewound.checkpointIds).toEqual([meta!.id])
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello\n')
    expect(existsSync(join(workspace, 'sub.txt'))).toBe(false)
  })

  it('leaves checkpoint unresolved when undo hits I/O failures', () => {
    writeFileSync(join(workspace, 'b.txt'), 'beta\n', 'utf8')
    const cp = beginWriteCheckpoint(runDir, workspace)
    cp.recordPrior('a.txt', 'write')
    cp.recordPrior('b.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'A\n', 'utf8')
    writeFileSync(join(workspace, 'b.txt'), 'B\n', 'utf8')
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta).not.toBeNull()

    rmSync(join(runDir, 'checkpoints', meta!.id, 'files', 'a.txt'), { force: true })

    const result = undoWrites(runDir, workspace, meta!.id)
    expect(result.restored).toEqual(['b.txt'])
    expect(result.skipped).toContain('a.txt')

    const persisted = getWriteCheckpointMeta(runDir, meta!.id)
    expect(persisted?.resolved).not.toBe(true)
    expect(persisted?.undone).not.toBe(true)
    expect(persisted?.files.find((f) => f.path === 'a.txt')?.resolved).toBeUndefined()
    expect(persisted?.files.find((f) => f.path === 'b.txt')?.resolved).toBe('discarded')
  })

  it('getWriteCheckpointMeta returns null for empty/invalid ids without throwing', () => {
    expect(getWriteCheckpointMeta(runDir, '')).toBeNull()
    expect(getWriteCheckpointMeta(runDir, 'not-a-uuid')).toBeNull()
  })

  it('resolveWrites soft no-op with no checkpoint returns empty id safely', () => {
    const result = resolveWrites(runDir, workspace, { action: 'keep' })
    expect(result.checkpointId).toBe('')
    expect(result.fullyResolved).toBe(true)
    expect(getWriteCheckpointMeta(runDir, result.checkpointId)).toBeNull()
  })
})
