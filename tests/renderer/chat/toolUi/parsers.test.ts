import { describe, expect, it } from 'vitest'
import { parseGrepData } from '@renderer/features/chat/toolUi/parsers/grep'
import { parseListDirData } from '@renderer/features/chat/toolUi/parsers/listDir'
import { parseGlobData } from '@renderer/features/chat/toolUi/parsers/glob'
import { parseSearchData } from '@renderer/features/chat/toolUi/parsers/search'
import { parseDeleteData } from '@renderer/features/chat/toolUi/parsers/delete'
import { parseTodoData } from '@renderer/features/chat/toolUi/parsers/todo'
import { parseWebSearchData } from '@renderer/features/chat/toolUi/parsers/webSearch'
import { parseGitCommitData, parseGitDiffData, parseGitStatusData } from '@renderer/features/chat/toolUi/parsers/git'
import {
  parseBrowserActionData,
  parseBrowserSnapshotData,
  parseBrowserTabsData
} from '@renderer/features/chat/toolUi/parsers/browser'
import { parseDiagnosticsData } from '@renderer/features/chat/toolUi/parsers/diagnostics'
import { parseMcpIntrospectData } from '@renderer/features/chat/toolUi/parsers/mcpIntrospect'
import { parseMcpPinData } from '@renderer/features/chat/toolUi/parsers/mcpPin'
import { parseSkillData } from '@renderer/features/chat/toolUi/parsers/skill'
import { parseStatusMessageData } from '@renderer/features/chat/toolUi/parsers/status'
import type { UiToolRow } from '@shared/transcript'

function tool(overrides: Partial<UiToolRow> & Pick<UiToolRow, 'name'>): UiToolRow {
  return { id: 't1', summary: '', status: 'done', ...overrides }
}

describe('grep parser', () => {
  it('groups context matches by file', () => {
    const data = parseGrepData(
      tool({
        name: 'grep',
        argsPreview: JSON.stringify({ pattern: 'foo' }),
        content: 'src/a.ts:10\n> 10| const foo = 1\n  9| before\n  11| after'
      })
    )
    expect(data.matchCount).toBeGreaterThan(0)
    expect(data.groups[0]?.file).toBe('src/a.ts')
  })
})

describe('list_dir parser', () => {
  it('parses directory entries', () => {
    const data = parseListDirData(
      tool({
        name: 'list_dir',
        content: 'src (2 entries)\n[dir]  components/\n[file] index.ts (1K)'
      })
    )
    expect(data.totalEntries).toBe(2)
    expect(data.entries).toHaveLength(2)
    expect(data.entries[0]?.kind).toBe('dir')
    expect(data.entries[1]?.size).toBe('1K')
  })

  it('normalizes bare byte counts in file sizes', () => {
    const data = parseListDirData(
      tool({
        name: 'list_dir',
        content: '. (1 entries)\n[file] notes.md (1338)'
      })
    )
    expect(data.entries[0]?.size).toBe('1K')
  })
})

describe('glob parser', () => {
  it('collects paths', () => {
    const data = parseGlobData(
      tool({
        name: 'glob',
        argsPreview: JSON.stringify({ pattern: '**/*.ts' }),
        content: 'src/a.ts\nsrc/b.ts'
      })
    )
    expect(data.paths).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

describe('search parser', () => {
  it('parses filename and content hits without a truncation flag', () => {
    const data = parseSearchData(
      tool({
        name: 'search',
        argsPreview: JSON.stringify({ query: 'alpha' }),
        content: 'file: src/a.ts\nsrc/b.ts:12: const alpha = 1'
      })
    )
    expect(data.hits).toHaveLength(2)
    expect(data.hits[0]?.isFilenameHit).toBe(true)
    expect(data.hits[1]).toMatchObject({ file: 'src/b.ts', line: 12, isFilenameHit: false })
    expect(data.truncated).toBe(false)
  })

  it('flags the stopped-at-N-matches notice and keeps it out of the hits', () => {
    const data = parseSearchData(
      tool({
        name: 'search',
        argsPreview: JSON.stringify({ query: 'alpha' }),
        content: 'src/a.ts:1: alpha\n… stopped at 40 matches'
      })
    )
    expect(data.hits).toHaveLength(1)
    expect(data.truncated).toBe(true)
  })

  it('flags the scan-cap notice as truncated', () => {
    const data = parseSearchData(
      tool({
        name: 'search',
        argsPreview: JSON.stringify({ query: 'alpha' }),
        content: 'src/a.ts:1: alpha\n… searched first 5000 files only (scan cap)'
      })
    )
    expect(data.hits).toHaveLength(1)
    expect(data.truncated).toBe(true)
  })
})

describe('delete parser', () => {
  it('always has a message for the body', () => {
    const data = parseDeleteData(
      tool({
        name: 'delete',
        argsPreview: JSON.stringify({ path: 'old.txt', recursive: true }),
        content: 'Deleted old.txt'
      })
    )
    expect(data.path).toBe('old.txt')
    expect(data.recursive).toBe(true)
    expect(data.message).toContain('Deleted')
  })
})

describe('todo parser', () => {
  it('parses checklist items', () => {
    const data = parseTodoData(
      tool({
        name: 'todo_write',
        content: '1/2 complete\n[ ] First\n[x] Second'
      })
    )
    expect(data.total).toBe(2)
    expect(data.items).toHaveLength(2)
    expect(data.items[1]?.status).toBe('completed')
  })
})

describe('web_search parser', () => {
  it('parses numbered hits with url and snippet', () => {
    const data = parseWebSearchData(
      tool({
        name: 'web_search',
        argsPreview: JSON.stringify({ query: 'vyotiq agent' }),
        content: [
          '# Web search: vyotiq agent',
          '',
          'Found 2 result(s):',
          '',
          '1. First Hit',
          '   https://example.com/a',
          '   Alpha snippet',
          '',
          '2. Second Hit',
          '   https://example.com/b'
        ].join('\n')
      })
    )
    expect(data.query).toBe('vyotiq agent')
    expect(data.hits).toHaveLength(2)
    expect(data.hits[0]).toEqual({
      title: 'First Hit',
      url: 'https://example.com/a',
      snippet: 'Alpha snippet'
    })
    expect(data.hits[1]?.url).toBe('https://example.com/b')
  })

  it('returns empty hits for no results', () => {
    const data = parseWebSearchData(
      tool({
        name: 'web_search',
        summary: 'empty',
        content: '# Web search: empty\n\nNo results.'
      })
    )
    expect(data.hits).toEqual([])
  })
})

describe('git parsers', () => {
  it('parses git_status file rows', () => {
    const data = parseGitStatusData(
      tool({
        name: 'git_status',
        content: [
          'branch: main',
          'commits: yes',
          'remote: yes',
          'files: 1',
          '+2 -1',
          '',
          'M          +2 -1  src/a.ts'
        ].join('\n')
      })
    )
    expect(data.branch).toBe('main')
    expect(data.clean).toBe(false)
    expect(data.files).toEqual([{ status: 'M', path: 'src/a.ts', added: 2, removed: 1 }])
  })

  it('parses git_diff unified content', () => {
    const data = parseGitDiffData(
      tool({
        name: 'git_diff',
        argsPreview: JSON.stringify({ path: 'src/a.ts' }),
        content: ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,2 @@', ' context', '+added', '-removed'].join(
          '\n'
        )
      })
    )
    expect(data.path).toBe('src/a.ts')
    expect(data.added).toBe(1)
    expect(data.removed).toBe(1)
    expect(data.lines.some((l) => l.kind === 'add')).toBe(true)
  })

  it('parses git_commit message and flags from args/content', () => {
    const data = parseGitCommitData(
      tool({
        name: 'git_commit',
        summary: 'git commit',
        argsPreview: JSON.stringify({ message: 'fix: wire up' }),
        content: ['Committed', 'committed: true', 'pushed: false', 'message: fix: wire up'].join('\n')
      })
    )
    expect(data.message).toBe('fix: wire up')
    expect(data.committed).toBe(true)
    expect(data.pushed).toBe(false)
    expect(data.detail).toBe('Committed')
    expect(data.summary).toBe('git commit')
  })

  it('parses optional git_commit hash lines', () => {
    const data = parseGitCommitData(
      tool({
        name: 'git_commit',
        content: ['abc1234', 'committed: true', 'message: ship it'].join('\n')
      })
    )
    expect(data.hash).toBe('abc1234')
    expect(data.message).toBe('ship it')
  })
})

describe('browser parsers', () => {
  it('parses browser_snapshot refs and body', () => {
    const data = parseBrowserSnapshotData(
      tool({
        name: 'browser_snapshot',
        content: [
          'URL: https://example.com',
          'Title: Example',
          'tab_id: t1',
          'Viewport: 1280x720',
          '',
          'Interactive elements (use @eN with browser_click / browser_type):',
          '- @e1 button "Submit" css="#submit"',
          '- @e2 link "Home" css="a.home"',
          '',
          'Example page body text'
        ].join('\n')
      })
    )
    expect(data.url).toBe('https://example.com')
    expect(data.title).toBe('Example')
    expect(data.tabId).toBe('t1')
    expect(data.refs).toHaveLength(2)
    expect(data.refs[0]).toEqual({
      id: 'e1',
      role: 'button',
      name: 'Submit',
      css: '#submit'
    })
    expect(data.body).toContain('Example page body text')
  })

  it('parses browser_tabs list rows', () => {
    const data = parseBrowserTabsData(
      tool({
        name: 'browser_tabs',
        argsPreview: JSON.stringify({ action: 'list' }),
        content: '* t1  Example  https://example.com\n  t2  (untitled)  (blank)'
      })
    )
    expect(data.action).toBe('list')
    expect(data.tabs).toEqual([
      { id: 't1', title: 'Example', url: 'https://example.com' },
      { id: 't2', title: '(untitled)', url: '(blank)' }
    ])
  })

  it('parses browser action target and message', () => {
    const data = parseBrowserActionData(
      tool({
        name: 'browser_navigate',
        argsPreview: JSON.stringify({ url: 'https://example.com' }),
        content: 'Navigated to https://example.com\nTitle: Example\ntab_id: t1'
      })
    )
    expect(data.target).toBe('https://example.com')
    expect(data.message).toContain('Navigated to')
  })
})

describe('diagnostics parser', () => {
  it('parses issue rows', () => {
    const data = parseDiagnosticsData(
      tool({
        name: 'diagnostics',
        argsPreview: JSON.stringify({ kind: 'typecheck' }),
        content: [
          'command: pnpm run typecheck',
          'diagnostics: 2',
          '',
          'src/a.ts:10:5: error: Type mismatch',
          'src/b.ts:2:1: warning: Unused'
        ].join('\n')
      })
    )
    expect(data.kind).toBe('typecheck')
    expect(data.command).toBe('pnpm run typecheck')
    expect(data.issues).toHaveLength(2)
    expect(data.issues[0]?.severity).toBe('error')
    expect(data.issues[1]?.file).toBe('src/b.ts')
  })
})

describe('mcp introspect parser', () => {
  it('parses mcp_list_tools rows', () => {
    const data = parseMcpIntrospectData(
      tool({
        name: 'mcp_list_tools',
        content:
          '- mcp__github__list_issues readOnlyHint=true: List issues\n- mcp__github__create_issue readOnlyHint=false: Create'
      })
    )
    expect(data.kind).toBe('tools')
    expect(data.tools).toHaveLength(2)
    expect(data.tools[0]?.readOnly).toBe(true)
    expect(data.tools[1]?.readOnly).toBe(false)
  })

  it('parses mcp_list_resources bracket rows', () => {
    const data = parseMcpIntrospectData(
      tool({
        name: 'mcp_list_resources',
        content: '- [github] file://readme (README): text/plain — Project readme'
      })
    )
    expect(data.kind).toBe('resources')
    expect(data.entries[0]).toEqual({
      serverId: 'github',
      label: 'file://readme (README)',
      meta: 'text/plain — Project readme'
    })
  })

  it('prefers serverId then server_id for header filter', () => {
    const fromCamel = parseMcpIntrospectData(
      tool({
        name: 'mcp_list_tools',
        argsPreview: JSON.stringify({ serverId: 'github' }),
        content: '- mcp__github__list_issues readOnlyHint=true: List'
      })
    )
    expect(fromCamel.filter).toBe('github')

    const fromSnake = parseMcpIntrospectData(
      tool({
        name: 'mcp_list_tools',
        argsPreview: JSON.stringify({ server_id: 'linear' }),
        content: '- mcp__linear__issues readOnlyHint=true: List'
      })
    )
    expect(fromSnake.filter).toBe('linear')
  })

  it('parses mcp_read_resource body', () => {
    const data = parseMcpIntrospectData(
      tool({
        name: 'mcp_read_resource',
        argsPreview: JSON.stringify({ uri: 'file://readme' }),
        content: '# Readme\n\nHello'
      })
    )
    expect(data.kind).toBe('resource')
    expect(data.filter).toBe('file://readme')
    expect(data.text).toContain('# Readme')
  })

  it('parses mcp_get_prompt blocks', () => {
    const data = parseMcpIntrospectData(
      tool({
        name: 'mcp_get_prompt',
        argsPreview: JSON.stringify({ name: 'review' }),
        content: 'Code review prompt\n\nuser: Please review this change'
      })
    )
    expect(data.kind).toBe('prompt')
    expect(data.filter).toBe('review')
    expect(data.text).toContain('Code review')
    expect(data.blocks.some((b) => b.role === 'user')).toBe(true)
  })
})

describe('status message parser', () => {
  it('parses switch_mode', () => {
    const data = parseStatusMessageData(
      tool({
        name: 'switch_mode',
        argsPreview: JSON.stringify({ mode: 'plan' }),
        content: 'Mode switched from agent to plan. Tool availability updated for subsequent steps.'
      })
    )
    expect(data.chip).toBe('plan')
    expect(data.message).toContain('Mode switched')
  })

  it('parses ask_question answers', () => {
    const data = parseStatusMessageData(
      tool({
        name: 'ask_question',
        content: 'User answered:\n- Option A\n- Option B'
      })
    )
    expect(data.chip).toBe('Answered')
    expect(data.answers).toEqual(['Option A', 'Option B'])
  })

  it('parses labeled multi-question answers', () => {
    const data = parseStatusMessageData(
      tool({
        name: 'ask_question',
        content: 'User answered:\n- Mode?: Ask\n- Continue?: Yes'
      })
    )
    expect(data.chip).toBe('Answered')
    expect(data.answers).toEqual(['Mode?: Ask', 'Continue?: Yes'])
  })
})

describe('skill parser', () => {
  it('parses root skill markdown with name from args', () => {
    const data = parseSkillData(
      tool({
        name: 'Skill',
        argsPreview: JSON.stringify({ name: 'code-review' }),
        content: '# Skill: code-review\n\nReview code carefully.\n\n- Step one'
      })
    )
    expect(data.kind).toBe('markdown')
    expect(data.name).toBe('code-review')
    expect(data.relPath).toBe('')
    expect(data.content).toContain('Review code carefully.')
    expect(data.message).toBe('')
  })

  it('parses bundled skill file header including plugin-rule ids with slashes', () => {
    const data = parseSkillData(
      tool({
        name: 'Skill',
        argsPreview: JSON.stringify({ name: 'plugin-rule:pack/rules/x.md', path: 'docs/a.md' }),
        content: '# Skill file: plugin-rule:pack/rules/x.md / docs/a.md\n\n- [ ] Item'
      })
    )
    expect(data.kind).toBe('markdown')
    expect(data.relPath).toBe('docs/a.md')
    expect(data.content).toContain('- [ ] Item')

    const fromHeader = parseSkillData(
      tool({ name: 'Skill', content: '# Skill file: code-review / docs/checklist.md\n\nBody' })
    )
    expect(fromHeader.name).toBe('code-review')
    expect(fromHeader.relPath).toBe('docs/checklist.md')
  })

  it('parses directory listings into a file list', () => {
    const data = parseSkillData(
      tool({
        name: 'Skill',
        argsPreview: JSON.stringify({ name: 'code-review', path: 'docs' }),
        content: 'Directory: docs\n- docs/a.md\n- docs/b.md'
      })
    )
    expect(data.kind).toBe('directory')
    expect(data.dirPath).toBe('docs')
    expect(data.files).toEqual(['docs/a.md', 'docs/b.md'])
    expect(data.message).toBe('')
  })

  it('falls back to raw message for errors and unknown formats', () => {
    const data = parseSkillData(
      tool({
        name: 'Skill',
        status: 'fail',
        argsPreview: JSON.stringify({ name: 'nope' }),
        content:
          'Unknown or disabled skill/plugin-rule: nope. Enable it in Marketplace, or check Available skills / Plugin rules.'
      })
    )
    expect(data.kind).toBe('message')
    expect(data.message).toContain('Unknown or disabled skill')
  })
})

describe('mcp pin/release parser', () => {
  it('parses pinned / already / unknown sections with counts and note', () => {
    const data = parseMcpPinData(
      tool({
        name: 'request_mcp_tools',
        argsPreview: JSON.stringify({ tools: ['mcp__gh__list_issues', 'mcp__gh__create_issue'] }),
        content: [
          'Pinned for next step (2): mcp__gh__list_issues, mcp__gh__create_issue',
          'Already pinned: mcp__gh__get_issue',
          'Unknown / unresolved: nope',
          'Definitions are append-admitted into the sticky catalog on the next model step (prior tool order kept). Idle pins may later unload (TTL / soft max); call release_mcp_tools when done.'
        ].join('\n')
      })
    )
    expect(data.filter).toBe('mcp__gh__list_issues +1')
    expect(data.pinnedCount).toBe(2)
    expect(data.releasedCount).toBeNull()
    expect(data.sections.map((s) => s.kind)).toEqual(['pinned', 'already', 'unknown'])
    expect(data.sections[0]?.names).toEqual(['mcp__gh__list_issues', 'mcp__gh__create_issue'])
    expect(data.sections[1]?.names).toEqual(['mcp__gh__get_issue'])
    expect(data.sections[2]?.names).toEqual(['nope'])
    expect(data.note).toContain('append-admitted')
    expect(data.message).toBe('')
  })

  it('keeps ambiguous unknown entries intact across inner commas', () => {
    const data = parseMcpPinData(
      tool({
        name: 'request_mcp_tools',
        content: 'Unknown / unresolved: list (ambiguous: mcp__a__list, mcp__b__list), nope'
      })
    )
    expect(data.sections).toHaveLength(1)
    expect(data.sections[0]?.names).toEqual([
      'list (ambiguous: mcp__a__list, mcp__b__list)',
      'nope'
    ])
  })

  it('parses release output with serverId filter', () => {
    const data = parseMcpPinData(
      tool({
        name: 'release_mcp_tools',
        argsPreview: JSON.stringify({ serverId: 'gh' }),
        content: [
          'Released (2): mcp__gh__list_issues, mcp__gh__create_issue',
          'Schemas drop from the sticky catalog on the next model step. Re-pin with request_mcp_tools if needed.'
        ].join('\n')
      })
    )
    expect(data.filter).toBe('gh')
    expect(data.releasedCount).toBe(2)
    expect(data.pinnedCount).toBeNull()
    expect(data.sections.map((s) => s.kind)).toEqual(['released'])
    expect(data.note).toContain('Schemas drop')
  })

  it('parses no-op lines without sections', () => {
    const data = parseMcpPinData(
      tool({ name: 'request_mcp_tools', content: 'No new tools pinned.' })
    )
    expect(data.noneMessage).toBe('No new tools pinned.')
    expect(data.sections).toHaveLength(0)
    expect(data.message).toBe('')

    const release = parseMcpPinData(
      tool({ name: 'release_mcp_tools', content: 'No pinned tools released.' })
    )
    expect(release.noneMessage).toBe('No pinned tools released.')
  })

  it('falls back to raw text for failures and unknown line formats', () => {
    const data = parseMcpPinData(
      tool({
        name: 'request_mcp_tools',
        status: 'fail',
        content: 'request_mcp_tools requires an active agent run.'
      })
    )
    expect(data.sections).toHaveLength(0)
    expect(data.message).toBe('request_mcp_tools requires an active agent run.')

    const unknown = parseMcpPinData(
      tool({ name: 'release_mcp_tools', content: 'some totally new output format' })
    )
    expect(unknown.message).toBe('some totally new output format')
  })
})
