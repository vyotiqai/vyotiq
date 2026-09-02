import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs'
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

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import { executeTool } from '@main/agent/tools'

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
    expect(await toolGlob(root, '**/*.rs')).not.toContain('Nested matches:')
  })

  it('lists nested matches when a root-relative glob misses a nested project folder', async () => {
    mkdirSync(join(root, 'murmur-youtube-main', 'windows'), { recursive: true })
    writeFileSync(
      join(root, 'murmur-youtube-main', 'windows', 'Murmur.CrossPlatform.slnf'),
      '<Solution />\n',
      'utf8'
    )
    writeFileSync(
      join(root, 'murmur-youtube-main', 'windows', 'Murmur.App.csproj'),
      '<Project />\n',
      'utf8'
    )
    const out = await toolGlob(root, 'windows/**/*.{sln,slnf,csproj}')
    expect(out).toContain('No files match windows/**/*.{sln,slnf,csproj}')
    expect(out).toContain('Paths are relative to the workspace root.')
    expect(out).toContain('Nested matches:')
    expect(out).toContain('murmur-youtube-main/windows/Murmur.CrossPlatform.slnf')
    expect(out).toContain('murmur-youtube-main/windows/Murmur.App.csproj')
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
    expect(out).toContain('- wrote src/a.ts')
    expect(out).toContain('- created src/new.ts')
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('updated a\n')
    expect(readFileSync(join(root, 'src', 'new.ts'), 'utf8')).toBe('brand new\n')
  })

  it('labels every new file as created', () => {
    const out = toolMultiEdit(root, [
      { path: 'src/one.ts', contents: 'one\n' },
      { path: 'src/two.ts', contents: 'two\n' }
    ])
    expect(out).toContain('- created src/one.ts')
    expect(out).toContain('- created src/two.ts')
    expect(out).not.toContain('- wrote')
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

  it('rejects empty contents for existing non-empty files without changing the batch', () => {
    expect(() =>
      toolMultiEdit(root, [
        { path: 'src/new-empty.ts', contents: 'would otherwise land\n' },
        { path: 'src/a.ts', contents: '' }
      ])
    ).toThrow(/no files changed.*empty contents/i)

    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toContain('export const alpha')
    expect(existsSync(join(root, 'src', 'new-empty.ts'))).toBe(false)
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

  it('does not clobber an existing target.tmp sibling', () => {
    const preserved = 'user temp contents\n'
    writeFileSync(join(root, 'src', 'a.ts.tmp'), preserved, 'utf8')
    toolMultiEdit(root, [{ path: 'src/a.ts', contents: 'updated a\n' }])
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('updated a\n')
    expect(readFileSync(join(root, 'src', 'a.ts.tmp'), 'utf8')).toBe(preserved)
  })

  it('rolls back completed renames when a later commit fails', () => {
    const originalA = readFileSync(join(root, 'src', 'a.ts'), 'utf8')
    const originalReadme = readFileSync(join(root, 'README.md'), 'utf8')
    // multi_edit resolves through resolveInsideWorkspace, which realpaths;
    // the injected rename seam receives that form, so match it (macOS tmpdir
    // sits under the /var → /private/var symlink).
    const readme = join(realpathSync(root), 'README.md')
    expect(() =>
      toolMultiEdit(
        root,
        [
          { path: 'src/a.ts', contents: 'should roll back\n' },
          { path: 'README.md', contents: 'should not land\n' }
        ],
        undefined,
        {
          renameSyncFn: (from, to) => {
            if (to === readme && from.endsWith('.tmp')) {
              throw new Error('simulated mid-commit failure')
            }
            renameSync(from, to)
          }
        }
      )
    ).toThrow(/simulated mid-commit failure/)
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe(originalA)
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(originalReadme)
  })
})

describe('multi_edit summary', () => {
  it('counts unique slash-normalized paths in the N files summary', async () => {
    toolTodoWrite(root, [{ id: '1', content: 'Update nested TypeScript files', status: 'in_progress' }])
    const result = await executeTool(
      'multi_edit',
      JSON.stringify({
        edits: [
          { path: 'src/a.ts', contents: 'updated a\n' },
          { path: 'src\\nested\\b.ts', contents: 'updated b\n' }
        ]
      }),
      root,
      new AbortController().signal,
      { runDir: root, agentMode: 'agent' }
    )
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('2 files')
    expect(readFileSync(join(root, 'src', 'nested', 'b.ts'), 'utf8')).toBe('updated b\n')
  })

  it('rejects an edit that passes both contents and diff', async () => {
    const result = await executeTool(
      'multi_edit',
      JSON.stringify({
        edits: [
          {
            path: 'src/a.ts',
            contents: 'updated\n',
            diff: '@@ -1 +1 @@\n-export const alpha = 1\n+updated\n'
          }
        ]
      }),
      root,
      new AbortController().signal
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/contents or diff, not both/)
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toContain('export const alpha')
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

  it('does not treat an empty file line as the closest match', () => {
    writeFileSync(
      join(root, 'loopish.ts'),
      ['import { x } from "y"', '', '', 'export const keep = 1', ''].join('\n'),
      'utf8'
    )
    try {
      toolStrReplace(root, 'loopish.ts', 'export const REMOVED_CONSTANT = 1', 'export const keep = 2')
      expect.fail('expected throw')
    } catch (err) {
      const text = String(err)
      expect(text).toMatch(/old_string not found/)
      expect(text).not.toMatch(/Closest match near line \d+: ""/)
      expect(text).toMatch(/export const keep = 1/)
    }
  })
})

describe('toolTodoWrite', () => {
  it('persists the list and renders progress', () => {
    const { content } = toolTodoWrite(root, [
      { id: '1', content: 'First', status: 'completed' },
      { id: '2', content: 'Second', status: 'in_progress' }
    ])

    expect(content).toContain('1/2 complete')
    expect(content).toContain('[x] (1) First')
    expect(content).toContain('[~] (2) Second')
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
    const { content, todos, notice } = toolTodoWrite(root, [
      { id: '1', content: 'First', status: 'in_progress' },
      { id: '2', content: 'Second', status: 'in_progress' }
    ])
    expect(todos.find((todo) => todo.id === '1')?.status).toBe('pending')
    expect(todos.find((todo) => todo.id === '2')?.status).toBe('in_progress')
    expect(notice).toMatch(/demoted 1 to pending/i)
    expect(content).not.toMatch(/^Note:/m)
    expect(content).toContain('[ ] (1) First')
    expect(content).toContain('[~] (2) Second')
  })

  it('collapses newlines in content and keeps one line per task', () => {
    const { content, todos } = toolTodoWrite(root, [
      { id: '1', content: 'First\nline', status: 'pending' }
    ])
    expect(todos[0]?.content).toBe('First line')
    expect(content).toBe('0/1 complete\n[ ] (1) First line')
  })

  it('summarizes merged list length, not input length', async () => {
    toolTodoWrite(root, [
      { id: '1', content: 'First', status: 'pending' },
      { id: '2', content: 'Second', status: 'pending' },
      { id: '3', content: 'Third', status: 'pending' }
    ])
    const result = await executeTool(
      'todo_write',
      JSON.stringify({
        todos: [{ id: '2', content: 'Second', status: 'completed' }],
        merge: true
      }),
      root,
      new AbortController().signal,
      { runDir: root }
    )
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('3 tasks')
    expect(result.content).toContain('1/3 complete')
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
