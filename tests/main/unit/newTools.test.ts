import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { toolGlob } from '@main/agent/tools/glob'
import { toolGrep } from '@main/agent/tools/grep'
import { toolListDir } from '@main/agent/tools/listDir'
import { toolMultiEdit } from '@main/agent/tools/multiEdit'
import { toolDelete } from '@main/agent/tools/deletePath'
import { toolStrReplace } from '@main/agent/tools/strReplace'
import { readTodos, toolTodoWrite } from '@main/agent/tools/todo'
import { htmlToMarkdown, spaShellWarning, extractMainHtml } from '@main/agent/tools/webFetch'
import { globToRegExp } from '@main/agent/tools/walk'
import { executeTool } from '@main/agent/tools'
import { validateToolArgs } from '@main/agent/schemas/tools'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vyotiq-tools-'))
  mkdirSync(join(root, 'src', 'nested'), { recursive: true })
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, '.gitignore'), 'ignored.ts\n', 'utf8')
  writeFileSync(join(root, 'README.md'), '# Readme\nalpha\n', 'utf8')
  writeFileSync(join(root, 'src', 'a.ts'), 'export const alpha = 1\nconst other = 2\n', 'utf8')
  writeFileSync(join(root, 'src', 'nested', 'b.ts'), 'export const beta = alpha\n', 'utf8')
  writeFileSync(join(root, 'src', 'ignored.ts'), 'export const ignored = true\n', 'utf8')
  writeFileSync(join(root, 'build', 'bundle.js'), 'alpha\n', 'utf8')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('globToRegExp', () => {
  it('matches ** across directories and zero directories', () => {
    const re = globToRegExp('src/**/*.ts')
    expect(re.test('src/a.ts')).toBe(true)
    expect(re.test('src/nested/b.ts')).toBe(true)
    expect(re.test('lib/a.ts')).toBe(false)
  })

  it('honours brace alternatives and single-segment stars', () => {
    const re = globToRegExp('*.{md,txt}')
    expect(re.test('README.md')).toBe(true)
    expect(re.test('notes.txt')).toBe(true)
    expect(re.test('src/README.md')).toBe(false)
  })

  it('escapes * and ? inside brace alternatives without throwing', () => {
    const re = globToRegExp('**/{AGENTS.md,package.json,README*,*.md}')
    expect(re.test('README*')).toBe(true)
    expect(re.test('*.md')).toBe(true)
    expect(re.test('AGENTS.md')).toBe(true)
    expect(re.test('README.md')).toBe(false)
  })
})

describe('toolGlob', () => {
  it('lists matching files and skips gitignored and build output', async () => {
    const out = await toolGlob(root, '**/*.ts')
    expect(out).toContain('src/a.ts')
    expect(out).toContain('src/nested/b.ts')
    expect(out).not.toContain('ignored.ts')
    expect(out).not.toContain('bundle.js')
  })

  it('reports no matches without throwing', async () => {
    expect(await toolGlob(root, '**/*.rs')).toContain('No files match')
  })
})

describe('toolGrep', () => {
  it('reports every matching line, not just the first file', async () => {
    const out = await toolGrep(root, 'alpha')
    expect(out).toContain('README.md:2')
    expect(out).toContain('src/a.ts:1')
    expect(out).toContain('src/nested/b.ts:1')
  })

  it('limits the search with an include glob', async () => {
    const out = await toolGrep(root, 'alpha', { include: 'src/**/*.ts' })
    expect(out).toContain('src/a.ts:1')
    expect(out).not.toContain('README.md')
  })

  it('adds context lines around a hit', async () => {
    const out = await toolGrep(root, 'other', { contextLines: 1 })
    expect(out).toContain('> 2|')
    expect(out).toContain('  1|')
  })

  it('rejects an invalid pattern instead of matching nothing', async () => {
    await expect(toolGrep(root, '([')).rejects.toThrow(/Invalid regex/)
  })
})

describe('toolListDir', () => {
  it('lists directories first and hides ignored entries', () => {
    const out = toolListDir(root, 'src')
    expect(out.indexOf('[dir]  nested/')).toBeLessThan(out.indexOf('[file] a.ts'))
    expect(out).not.toContain('ignored.ts')
  })

  it('refuses a file path', () => {
    expect(() => toolListDir(root, 'README.md')).toThrow(/Not a directory/)
  })
})

describe('toolMultiEdit', () => {
  it('writes every edit when all of them apply', () => {
    const out = toolMultiEdit(root, [
      { path: 'src/a.ts', contents: 'updated a\n' },
      { path: 'src/new.ts', contents: 'brand new\n' }
    ])

    expect(out).toContain('Applied 2 edits')
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('updated a\n')
    expect(readFileSync(join(root, 'src', 'new.ts'), 'utf8')).toBe('brand new\n')
  })

  it('writes nothing when one edit fails to apply', () => {
    expect(() =>
      toolMultiEdit(root, [
        { path: 'src/a.ts', contents: 'should not land\n' },
        { path: 'README.md', diff: '@@ -1,1 +1,1 @@\n-nonexistent line\n+replacement\n' }
      ])
    ).toThrow(/no files changed/)

    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toContain('export const alpha')
  })

  it('rejects a duplicated path rather than silently keeping the last write', () => {
    expect(() =>
      toolMultiEdit(root, [
        { path: 'src/a.ts', contents: 'first\n' },
        { path: 'src/a.ts', contents: 'second\n' }
      ])
    ).toThrow(/twice/)
  })

  it('rejects old_string/new_string and points to str_replace', () => {
    expect(() =>
      toolMultiEdit(root, [
        {
          path: 'src/a.ts',
          old_string: 'alpha',
          new_string: 'beta'
        }
      ])
    ).toThrow(/str_replace/)
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toContain('export const alpha')
  })
})

describe('multi_edit schema', () => {
  it('rejects edits that omit both contents and diff', () => {
    const result = validateToolArgs(
      'multi_edit',
      JSON.stringify({ edits: [{ path: 'a.ts' }] })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/contents or diff/)
  })

  it('rejects duplicate paths in edits', () => {
    const result = validateToolArgs(
      'multi_edit',
      JSON.stringify({
        edits: [
          { path: 'a.ts', contents: 'one' },
          { path: 'a.ts', contents: 'two' }
        ]
      })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/duplicate path/i)
  })
})

describe('multi_edit summary', () => {
  it('counts unique slash-normalized paths in the N files summary', async () => {
    const result = await executeTool(
      'multi_edit',
      JSON.stringify({
        edits: [
          { path: 'src/a.ts', contents: 'updated a\n' },
          { path: 'src\\nested\\b.ts', contents: 'updated b\n' }
        ]
      }),
      root,
      new AbortController().signal
    )
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('2 files')
    expect(readFileSync(join(root, 'src', 'nested', 'b.ts'), 'utf8')).toBe('updated b\n')
  })
})

describe('browser_select_option schema', () => {
  it('requires value or label', () => {
    const missing = validateToolArgs(
      'browser_select_option',
      JSON.stringify({ selector: '#sel' })
    )
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error).toMatch(/value or label/i)

    expect(
      validateToolArgs(
        'browser_select_option',
        JSON.stringify({ selector: '#sel', value: 'a' })
      ).ok
    ).toBe(true)
  })
})

describe('terminal / grep pattern bounds', () => {
  it('rejects oversized terminal patterns', () => {
    const result = validateToolArgs(
      'terminal',
      JSON.stringify({ command: 'echo hi', pattern: 'a'.repeat(201) })
    )
    expect(result.ok).toBe(false)
  })

  it('rejects invented terminal session_id labels', () => {
    const result = validateToolArgs(
      'terminal',
      JSON.stringify({ session_id: 'inspect2', block_until_ms: 1000 })
    )
    expect(result.ok).toBe(false)
  })

  it('accepts a UUID session_id for polling', () => {
    const result = validateToolArgs(
      'terminal',
      JSON.stringify({
        session_id: '550e8400-e29b-41d4-a716-446655440000',
        block_until_ms: 1000
      })
    )
    expect(result.ok).toBe(true)
  })

  it('strips invented session_id when command is also present', () => {
    const result = validateToolArgs(
      'terminal',
      JSON.stringify({ command: 'echo hi', session_id: 'run1' })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.session_id).toBeUndefined()
      expect(result.data.command).toBe('echo hi')
    }
  })

  it('strips invented UUID session_id when command is also present', () => {
    const result = validateToolArgs(
      'terminal',
      JSON.stringify({
        command: 'echo hi',
        session_id: '98d4409e-3951-4807-85b5-df6f57708d08',
        block_until_ms: 10000
      })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.session_id).toBeUndefined()
      expect(result.data.command).toBe('echo hi')
    }
  })
})

describe('tool arg bounds', () => {
  it('strips unknown read keys and applies path/limit aliases', () => {
    const result = validateToolArgs(
      'read',
      JSON.stringify({
        name: 'src/a.ts',
        maxChars: 500,
        expected_params: { path: 'ignored' },
        junk: true
      })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.path).toBe('src/a.ts')
      expect(result.data.limit).toBe(500)
      expect(result.data).not.toHaveProperty('name')
      expect(result.data).not.toHaveProperty('maxChars')
      expect(result.data).not.toHaveProperty('expected_params')
      expect(result.data).not.toHaveProperty('junk')
    }
  })

  it('keeps canonical read path over name alias', () => {
    const result = validateToolArgs(
      'read',
      JSON.stringify({ path: 'canonical.ts', name: 'alias.ts' })
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.path).toBe('canonical.ts')
  })

  it('aliases grep path to include and strips junk keys', () => {
    const result = validateToolArgs(
      'grep',
      JSON.stringify({
        pattern: 'agent',
        path: 'src/context_engine/cli.py',
        caseSensitive: false,
        expected_params: true
      })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.pattern).toBe('agent')
      expect(result.data.include).toBe('src/context_engine/cli.py')
      expect(result.data).not.toHaveProperty('path')
      expect(result.data).not.toHaveProperty('expected_params')
    }
  })

  it('keeps canonical grep include over path alias', () => {
    const result = validateToolArgs(
      'grep',
      JSON.stringify({ pattern: 'x', include: 'src/a.ts', path: 'src/b.ts' })
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.include).toBe('src/a.ts')
  })

  it('clarifies ask_question type errors', () => {
    const result = validateToolArgs(
      'ask_question',
      JSON.stringify({
        questions: [{ id: 'q1', prompt: 'Ready?', options: ['yes', 'no'] }]
      })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/type/i)
      expect(result.error).toMatch(/single, multi, boolean, text/)
    }
  })

  it('rejects search maxResults of 0', () => {
    const result = validateToolArgs('search', JSON.stringify({ query: 'x', maxResults: 0 }))
    expect(result.ok).toBe(false)
  })

  it('rejects empty todo ids and wipe-all empty replace lists', () => {
    expect(
      validateToolArgs(
        'todo_write',
        JSON.stringify({ todos: [{ id: '', content: 'x', status: 'pending' }] })
      ).ok
    ).toBe(false)
    expect(validateToolArgs('todo_write', JSON.stringify({ todos: [] })).ok).toBe(false)
    expect(
      validateToolArgs('todo_write', JSON.stringify({ todos: [], merge: true })).ok
    ).toBe(true)
  })

  it('rejects negative terminal timeoutMs', () => {
    expect(
      validateToolArgs('terminal', JSON.stringify({ command: 'echo hi', timeoutMs: -1 })).ok
    ).toBe(false)
  })

  it('rejects terminal timeoutMs above the configured maximum', () => {
    expect(
      validateToolArgs('terminal', JSON.stringify({ command: 'echo hi', timeoutMs: 999_999_999 }))
        .ok
    ).toBe(false)
  })
})

describe('toolDelete', () => {
  it('deletes a file', () => {
    expect(toolDelete(root, 'README.md')).toContain('Deleted README.md')
    expect(existsSync(join(root, 'README.md'))).toBe(false)
  })

  it('requires recursive for a non-empty directory', () => {
    expect(() => toolDelete(root, 'src')).toThrow(/recursive=true/)
    expect(existsSync(join(root, 'src'))).toBe(true)
    toolDelete(root, 'src', true)
    expect(existsSync(join(root, 'src'))).toBe(false)
  })

  it('refuses to escape the workspace or delete its root', () => {
    expect(() => toolDelete(root, '..')).toThrow()
    expect(() => toolDelete(root, '.')).toThrow(/workspace root/)
  })

  it('reports File not found with similar names when the path is missing', () => {
    expect(() => toolDelete(root, 'src/missing.ts')).toThrow(/File not found: src\/missing\.ts/)
    expect(() => toolDelete(root, 'src/missing.ts')).toThrow(/Similar names in parent directory/)
  })
})

describe('toolStrReplace', () => {
  it('replaces a unique occurrence', () => {
    const out = toolStrReplace(root, 'src/a.ts', 'alpha', 'gamma')
    expect(out).toContain('1 occurrence')
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toContain('gamma')
  })

  it('fails when old_string matches more than once unless replace_all', () => {
    writeFileSync(join(root, 'dup.ts'), 'aa aa aa\n', 'utf8')
    expect(() => toolStrReplace(root, 'dup.ts', 'aa', 'bb')).toThrow(/matched 3 times/)
    const out = toolStrReplace(root, 'dup.ts', 'aa', 'bb', true)
    expect(out).toContain('3 occurrences')
    expect(readFileSync(join(root, 'dup.ts'), 'utf8')).toBe('bb bb bb\n')
  })

  it('fails when old_string is missing', () => {
    expect(() => toolStrReplace(root, 'src/a.ts', 'nope', 'x')).toThrow(/not found/)
  })
})

describe('toolTodoWrite', () => {
  it('persists the list and renders progress', () => {
    const { content } = toolTodoWrite(root, [
      { id: '1', content: 'First', status: 'completed' },
      { id: '2', content: 'Second', status: 'in_progress' }
    ])

    expect(content).toContain('1/2 complete')
    expect(content).toContain('[x] First')
    expect(content).toContain('[~] Second')
    expect(readTodos(root)).toHaveLength(2)
  })

  it('merges status updates into the existing list', () => {
    toolTodoWrite(root, [
      { id: '1', content: 'First', status: 'pending' },
      { id: '2', content: 'Second', status: 'pending' }
    ])
    toolTodoWrite(root, [{ id: '2', content: 'Second', status: 'completed' }], true)

    const todos = readTodos(root)
    expect(todos).toHaveLength(2)
    expect(todos.find((todo) => todo.id === '2')?.status).toBe('completed')
  })

  it('auto-demotes earlier in-progress tasks, keeping the last', () => {
    const { content, todos } = toolTodoWrite(root, [
      { id: '1', content: 'First', status: 'in_progress' },
      { id: '2', content: 'Second', status: 'in_progress' }
    ])
    expect(todos.find((todo) => todo.id === '1')?.status).toBe('pending')
    expect(todos.find((todo) => todo.id === '2')?.status).toBe('in_progress')
    expect(content).toMatch(/demoted 1 to pending/i)
    expect(content).toContain('[ ] First')
    expect(content).toContain('[~] Second')
  })
})

describe('htmlToMarkdown', () => {
  it('keeps headings, links and list items while dropping scripts', () => {
    const md = htmlToMarkdown(
      '<html><head><style>body{}</style></head><body><h1>Title</h1><script>evil()</script>' +
        '<p>Hello &amp; welcome</p><ul><li>one</li><li>two</li></ul>' +
        '<a href="https://example.test">link</a></body></html>'
    )

    expect(md).toContain('# Title')
    expect(md).toContain('Hello & welcome')
    expect(md).toContain('- one')
    expect(md).toContain('[link](https://example.test)')
    expect(md).not.toContain('evil()')
    expect(md).not.toContain('body{}')
  })

  it('strips nav chrome and empty list bullets from SPA shells', () => {
    const hfShell =
      '<html><body>' +
      '<header><nav><ul><li></li><li><a href="/models">Models</a></li>' +
      '<li><a href="/datasets">Datasets</a></li><li><a href="/spaces">Spaces</a></li></ul></nav></header>' +
      '<main><h1>LFM2.5-2.6B-GGUF</h1><p>Compact edge model for on-device inference.</p>' +
      '<ul><li>Q4_K_M quant</li><li>5.0 GB total</li></ul></main>' +
      '<footer><a href="/pricing">Pricing</a></footer>' +
      '</body></html>'

    const md = htmlToMarkdown(hfShell)

    expect(md).toContain('LFM2.5-2.6B-GGUF')
    expect(md).toContain('Compact edge model')
    expect(md).toContain('- Q4_K_M quant')
    expect(md).not.toMatch(/^-\s*$/m)
    expect(md).not.toContain('Models')
    expect(md).not.toContain('Datasets')
    expect(md).not.toContain('Pricing')
  })

  it('prefers main landmark content when present', () => {
    const html =
      '<div><nav>Skip me</nav><main><h2>Real title</h2><p>Body copy with enough substance to keep.</p></main></div>'
    expect(extractMainHtml(html)).toContain('Real title')
    expect(extractMainHtml(html)).not.toContain('Skip me')
  })
})

describe('spaShellWarning', () => {
  it('warns when markdown is mostly navigation labels', () => {
    const md = [
      '- Models',
      '- Datasets',
      '- Spaces',
      '- Docs',
      '- Enterprise',
      '- Pricing'
    ].join('\n')

    expect(spaShellWarning(md)).toMatch(/JavaScript-rendered shell/i)
  })

  it('does not warn when substantive prose is present', () => {
    const md = [
      '# LiquidAI/LFM2.5-2.6B-GGUF',
      'Compact edge model for on-device inference with 2.6B parameters.',
      'Recommended quant: Q4_K_M (~1.6 GB download).',
      'Use huggingface-cli download LiquidAI/LFM2.5-2.6B-GGUF --include "*.gguf"'
    ].join('\n')

    expect(spaShellWarning(md)).toBeNull()
  })
})
