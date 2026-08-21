import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import { executeTool } from '@main/agent/tools'
import { toolTodoWrite } from '@main/agent/tools/todo'
import { wireToolCallArguments } from '@main/agent/toolArgWire'

describe('parseToolArgs dispatch', () => {
  it('executeTool with unparseable JSON reports malformed args, not a missing field', async () => {
    const result = await executeTool('read', '{not-json', '/tmp/ws', new AbortController().signal)
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/malformed, truncated, or non-object/i)
    expect(result.content).not.toMatch(/path: Required/i)
    expect(result.content).not.toContain('trim')
  })

  it('executeTool with bare array JSON reports malformed args', async () => {
    const result = await executeTool(
      'read',
      JSON.stringify([{ path: 'a.ts' }]),
      '/tmp/ws',
      new AbortController().signal
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/must be one complete JSON object/i)
  })

  it('executeTool edit with empty args returns a clear path error', async () => {
    const result = await executeTool('edit', '{}', '/tmp/ws', new AbortController().signal)
    expect(result.ok).toBe(false)
    expect(result.content).toContain('edit requires path')
    expect(result.content).not.toContain('trim')
  })

  it('executeTool edit with path only returns a clear body error', async () => {
    const result = await executeTool(
      'edit',
      JSON.stringify({ path: 'manifest.json' }),
      '/tmp/ws',
      new AbortController().signal
    )
    expect(result.ok).toBe(false)
    expect(result.content).toContain('edit requires contents or diff')
  })

  it('does not leak undefined.length when multi_edit args are missing', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-multi-edit-missing-'))
    try {
      const result = await executeTool(
        'multi_edit',
        '{}',
        workspace,
        new AbortController().signal
      )
      expect(result.ok).toBe(false)
      expect(result.content).not.toContain("Cannot read properties of undefined (reading 'length')")
      expect(result.content).toContain(
        'multi_edit requires edits: [{ path, contents }] or edits: [{ path, diff }]'
      )
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('explains the complete multi_edit entry shape', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-multi-edit-shape-'))
    try {
      const missingPath = await executeTool(
        'multi_edit',
        JSON.stringify({ edits: [{ contents: 'next' }] }),
        workspace,
        new AbortController().signal
      )
      const missingBody = await executeTool(
        'multi_edit',
        JSON.stringify({ edits: [{ path: 'src/a.ts' }] }),
        workspace,
        new AbortController().signal
      )
      for (const result of [missingPath, missingBody]) {
        expect(result.ok).toBe(false)
        expect(result.content).toContain(
          'multi_edit requires edits: [{ path, contents }] or edits: [{ path, diff }]'
        )
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('does not leak undefined.length when todo_write args are missing', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'vyotiq-todo-missing-'))
    try {
      const result = await executeTool(
        'todo_write',
        '{}',
        runDir,
        new AbortController().signal,
        { runDir }
      )
      expect(result.ok).toBe(false)
      expect(result.content).not.toContain("Cannot read properties of undefined (reading 'length')")
      expect(result.content).toContain('todo_write requires todos')
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('executes todo_write with a bare top-level array', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'vyotiq-todo-array-'))
    const todos = [{ id: '1', content: 'Verify the fix', status: 'completed' }]
    try {
      const result = await executeTool(
        'todo_write',
        JSON.stringify(todos),
        runDir,
        new AbortController().signal,
        { runDir }
      )
      expect(result.ok).toBe(true)
      expect(result.summary).toBe('1 task')
      expect(JSON.parse(readFileSync(join(runDir, 'todos.json'), 'utf8'))).toMatchObject({ todos })
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('executes todo_write with a stringified todos array, including an unclosed bracket', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'vyotiq-todo-string-'))
    const todos = [{ id: '1', content: 'Verify the fix', status: 'completed' }]
    try {
      const stringified = await executeTool(
        'todo_write',
        JSON.stringify({ todos: JSON.stringify(todos) }),
        runDir,
        new AbortController().signal,
        { runDir }
      )
      expect(stringified.ok).toBe(true)
      expect(stringified.summary).toBe('1 task')

      const unclosed = await executeTool(
        'todo_write',
        JSON.stringify({ todos: JSON.stringify(todos).slice(0, -1) }),
        runDir,
        new AbortController().signal,
        { runDir }
      )
      expect(unclosed.ok).toBe(true)
      expect(JSON.parse(readFileSync(join(runDir, 'todos.json'), 'utf8'))).toMatchObject({ todos })
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('executeTool edit accepts file/content aliases', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-edit-alias-'))
    try {
      toolTodoWrite(workspace, [{ id: '1', content: 'Write alias.txt', status: 'in_progress' }])
      const result = await executeTool(
        'edit',
        JSON.stringify({ file: 'alias.txt', content: 'hello' }),
        workspace,
        new AbortController().signal,
        { runDir: workspace, agentMode: 'agent' }
      )
      expect(result.ok).toBe(true)
      expect(readFileSync(join(workspace, 'alias.txt'), 'utf8')).toBe('hello')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('executeTool remaps invented Write onto edit', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-write-alias-'))
    try {
      toolTodoWrite(workspace, [{ id: '1', content: 'Write invented.txt', status: 'in_progress' }])
      const result = await executeTool(
        'Write',
        JSON.stringify({ path: 'invented.txt', contents: 'from Write' }),
        workspace,
        new AbortController().signal,
        { runDir: workspace, agentMode: 'agent' }
      )
      expect(result.ok).toBe(true)
      expect(readFileSync(join(workspace, 'invented.txt'), 'utf8')).toBe('from Write')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe('wireToolCallArguments', () => {
  it('returns parseable object JSON or {}', () => {
    expect(wireToolCallArguments('read', '{"path":"a.ts"}')).toBe('{"path":"a.ts"}')
    expect(wireToolCallArguments('read', 'not-json')).toBe('{}')
    expect(wireToolCallArguments('read', '[]')).toBe('{}')
  })

  it('refuses to reconstruct truncated edit args', () => {
    // A partial `contents` still satisfies the edit schema, so salvaging here
    // would overwrite the file with a half-streamed body and report success.
    const truncated = '{"path":"manifest.json","contents":"{\\n  \\"name\\": \\"vy'
    expect(wireToolCallArguments('edit', truncated)).toBe('{}')
  })

  it('refuses to reconstruct truncated str_replace and multi_edit args', () => {
    expect(
      wireToolCallArguments('str_replace', '{"path":"a.ts","old_string":"x","new_string":"partia')
    ).toBe('{}')
    expect(
      wireToolCallArguments('multi_edit', '{"edits":[{"path":"a.ts","contents":"half')
    ).toBe('{}')
  })

  it('reports truncated write args as malformed instead of writing the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wire-trunc-'))
    try {
      const truncated = '{"path":"a.ts","contents":"half of a fi'
      const result = await executeTool(
        'edit',
        wireToolCallArguments('edit', truncated),
        dir,
        new AbortController().signal
      )
      expect(result.ok).toBe(false)
      expect(existsSync(join(dir, 'a.ts'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('wraps bare ask_question arrays', () => {
    const wired = wireToolCallArguments(
      'ask_question',
      '[{"id":"q1","prompt":"Pick?","type":"boolean"}]'
    )
    expect(JSON.parse(wired)).toEqual({
      questions: [{ id: 'q1', prompt: 'Pick?', type: 'boolean' }]
    })
  })

  it('wraps bare todo_write arrays', () => {
    const todos = [{ id: '1', content: 'Verify the fix', status: 'completed' }]
    expect(JSON.parse(wireToolCallArguments('todo_write', JSON.stringify(todos)))).toEqual({ todos })
  })

  it('salvages a complete value followed by a stray closing brace (live 4406e6a2)', () => {
    const wired = wireToolCallArguments(
      'ask_question',
      '[{"id":"q1","prompt":"Pick?","type":"boolean"}]}'
    )
    expect(JSON.parse(wired)).toEqual({
      questions: [{ id: 'q1', prompt: 'Pick?', type: 'boolean' }]
    })

    expect(JSON.parse(wireToolCallArguments('read', '{"path":"a.ts"}}'))).toEqual({
      path: 'a.ts'
    })
  })

  it('does not salvage a truncated payload with no complete value', () => {
    expect(wireToolCallArguments('ask_question', '{"questions": [{"id"')).toBe('{}')
  })

  it('keeps stray braces inside string values intact', () => {
    const wired = wireToolCallArguments('grep', '{"pattern":"interface\\\\{\\\\}"}')
    expect(JSON.parse(wired)).toEqual({ pattern: 'interface\\{\\}' })
  })
})
