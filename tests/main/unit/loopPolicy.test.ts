import { describe, expect, it } from 'vitest'
import {
  CONSECUTIVE_TOOL_FAILURE_SERIAL_THRESHOLD,
  applyToolCallToKnownPaths,
  combineLoopHints,
  deletePathFromToolCall,
  editPathsFromToolCall,
  isInspectToolName,
  loopHintForCompactionFailure,
  loopHintForOmittedMcpTools,
  maxParallelReadToolsForFailureStreak,
  normalizeWorkspaceRelPath,
  readPathFromToolCall,
  seedKnownPathsFromMessages,
  toolArgsFromCall,
  unreadExistingEditPaths
} from '@main/agent/loopPolicy'

describe('loopPolicy', () => {
  it('serializes parallel reads after consecutive failure threshold', () => {
    expect(
      maxParallelReadToolsForFailureStreak(CONSECUTIVE_TOOL_FAILURE_SERIAL_THRESHOLD - 1, 4)
    ).toBe(4)
    expect(
      maxParallelReadToolsForFailureStreak(CONSECUTIVE_TOOL_FAILURE_SERIAL_THRESHOLD, 4)
    ).toBe(1)
  })

  it('normalizes workspace-relative paths', () => {
    expect(normalizeWorkspaceRelPath('  src\\foo.ts  ')).toBe('src/foo.ts')
  })

  it('extracts read and edit paths from tool calls', () => {
    expect(readPathFromToolCall('read', { path: 'a\\b.ts' })).toBe('a/b.ts')
    expect(readPathFromToolCall('grep', { path: 'a.ts' })).toBeNull()
    expect(editPathsFromToolCall('str_replace', { path: 'x.ts' })).toEqual(['x.ts'])
    expect(
      editPathsFromToolCall('multi_edit', {
        edits: [{ path: 'a.ts' }, { path: 'b\\c.ts' }, { path: 1 }]
      })
    ).toEqual(['a.ts', 'b/c.ts'])
  })

  it('treats concrete grep include and glob pattern as inspect paths', () => {
    const known = new Set<string>()
    applyToolCallToKnownPaths(known, 'grep', { pattern: 'foo', include: 'src/a.ts' }, true)
    expect(known.has('src/a.ts')).toBe(true)
    applyToolCallToKnownPaths(known, 'glob', { pattern: 'src/**/*.ts' }, true)
    expect(known.has('src/**/*.ts')).toBe(false)
    applyToolCallToKnownPaths(known, 'glob', { pattern: 'src/b.ts' }, true)
    expect(known.has('src/b.ts')).toBe(true)
  })

  it('tracks known paths only on successful read/write', () => {
    const known = new Set<string>()
    applyToolCallToKnownPaths(known, 'read', { path: 'a.ts' }, false)
    expect(known.size).toBe(0)
    applyToolCallToKnownPaths(known, 'read', { path: 'a.ts' }, true)
    expect(known.has('a.ts')).toBe(true)
    applyToolCallToKnownPaths(known, 'edit', { path: 'b.ts' }, true)
    expect(known.has('b.ts')).toBe(true)
  })

  it('invalidates known paths after successful delete (always clears descendants)', () => {
    expect(deletePathFromToolCall('delete', { path: 'src\\a.ts' })).toBe('src/a.ts')
    expect(deletePathFromToolCall('edit', { path: 'src/a.ts' })).toBeNull()

    const known = new Set(['src/a.ts', 'src/dir/b.ts', 'src/dir/c.ts', 'other.ts'])
    applyToolCallToKnownPaths(known, 'delete', { path: 'src/a.ts' }, true)
    expect(known.has('src/a.ts')).toBe(false)
    expect(known.has('src/dir/b.ts')).toBe(true)

    // toolDelete always removes dir trees on success — clear descendants even without recursive arg
    applyToolCallToKnownPaths(known, 'delete', { path: 'src/dir' }, true)
    expect(known.has('src/dir/b.ts')).toBe(false)
    expect(known.has('src/dir/c.ts')).toBe(false)
    expect(known.has('other.ts')).toBe(true)

    // Failed delete must not clear inspect state.
    known.add('keep.ts')
    applyToolCallToKnownPaths(known, 'delete', { path: 'keep.ts' }, false)
    expect(known.has('keep.ts')).toBe(true)
  })

  it('treats delete-then-recreate as unread before edit for receipt observation', () => {
    const known = new Set<string>()
    applyToolCallToKnownPaths(known, 'read', { path: 'a.ts' }, true)
    applyToolCallToKnownPaths(known, 'delete', { path: 'a.ts' }, true)
    expect(known.has('a.ts')).toBe(false)
    const exists = (p: string) => p === 'a.ts'
    expect(unreadExistingEditPaths(known, 'edit', { path: 'a.ts' }, exists)).toEqual(['a.ts'])
  })

  it('detects existing unread edit paths for receipt observation', () => {
    const known = new Set(['seen.ts'])
    const exists = (p: string) => p === 'exists.ts' || p === 'seen.ts'
    expect(
      unreadExistingEditPaths(known, 'str_replace', { path: 'exists.ts' }, exists)
    ).toEqual(['exists.ts'])
    expect(
      unreadExistingEditPaths(known, 'str_replace', { path: 'seen.ts' }, exists)
    ).toEqual([])
    expect(
      unreadExistingEditPaths(known, 'edit', { path: 'brand-new.ts' }, exists)
    ).toEqual([])
    expect(unreadExistingEditPaths(known, 'read', { path: 'exists.ts' }, exists)).toEqual([])
  })

  it('combines omitted-MCP hints without injecting failure recipes', () => {
    const omitted = loopHintForOmittedMcpTools(['mcp__a__t1', 'mcp__b__t2'])
    expect(omitted).toMatch(/2 MCP tool/)
    expect(omitted).toMatch(/request_mcp_tools/)
    expect(omitted).not.toMatch(/Prefer built-in/i)
    expect(combineLoopHints(omitted, undefined)).toBe(omitted)
    expect(combineLoopHints(undefined, undefined)).toBeUndefined()
  })

  it('surfaces a compact run notice when auto-compaction produces no summary', () => {
    const hint = loopHintForCompactionFailure()
    expect(hint).toMatch(/compaction produced no summary/i)
    expect(hint).toMatch(/memory|\/compact/i)
    expect(combineLoopHints('mcp omit', hint)).toContain(hint)
  })

  it('seeds known paths only from successful matched tool results on resume', () => {
    const known = seedKnownPathsFromMessages([
      {
        role: 'assistant',
        toolCalls: [
          { id: 'r1', name: 'read', arguments: '{"path":"src/a.ts"}' },
          {
            id: 'e1',
            name: 'str_replace',
            arguments: '{"path":"src\\\\b.ts","old_string":"x","new_string":"y"}'
          },
          { id: 'r2', name: 'read', arguments: '{"path":"src/failed.ts"}' }
        ]
      },
      { role: 'tool', toolCallId: 'r1', toolName: 'read', ok: true },
      { role: 'tool', toolCallId: 'e1', toolName: 'str_replace', ok: true },
      { role: 'tool', toolCallId: 'r2', toolName: 'read', ok: false }
    ])
    expect(known.has('src/a.ts')).toBe(true)
    expect(known.has('src/b.ts')).toBe(true)
    expect(known.has('src/failed.ts')).toBe(false)
  })

  it('treats same-step concrete grep as inspect for unread observation', () => {
    const known = new Set<string>()
    const exists = (p: string) => p === 'src/a.ts'
    const calls = [
      { id: '1', name: 'grep' as const, arguments: '{"pattern":"x","include":"src/a.ts"}' },
      { id: '2', name: 'edit' as const, arguments: '{"path":"src/a.ts","content":"y"}' }
    ]
    for (const call of calls) {
      if (isInspectToolName(call.name)) {
        applyToolCallToKnownPaths(known, call.name, toolArgsFromCall(call.arguments), true)
      }
    }
    const unread: string[] = []
    for (const call of calls) {
      unread.push(
        ...unreadExistingEditPaths(known, call.name, toolArgsFromCall(call.arguments), exists)
      )
      if (!isInspectToolName(call.name)) {
        applyToolCallToKnownPaths(known, call.name, toolArgsFromCall(call.arguments), true)
      }
    }
    expect(unread).toHaveLength(0)
  })
})
