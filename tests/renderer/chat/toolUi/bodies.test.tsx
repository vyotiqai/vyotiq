/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ListDirBody } from '@renderer/features/chat/toolUi/bodies/ListDirBody'
import { McpPinBody } from '@renderer/features/chat/toolUi/bodies/McpPinBody'
import { SkillBody } from '@renderer/features/chat/toolUi/bodies/SkillBody'
import { DirListing } from '@renderer/features/chat/toolUi/primitives'
import type { UiToolRow } from '@shared/transcript'

function tool(overrides: Partial<UiToolRow> & Pick<UiToolRow, 'name'>): UiToolRow {
  return { id: 't1', summary: '', status: 'done', ...overrides }
}

const bodyProps = { expanded: true, loading: false, loadFailed: false }

describe('ListDirBody', () => {
  it('labels the listing as Directory and keeps sizes on the filename row', () => {
    const { container } = render(
      <ListDirBody
        {...bodyProps}
        tool={tool({
          name: 'list_dir',
          argsPreview: JSON.stringify({ path: 'src' }),
          content: [
            'Directory: src (2 entries)',
            '[dir] components',
            '[file] index.ts (2048)'
          ].join('\n')
        })}
      />
    )

    expect(screen.getByText('Directory')).toBeTruthy()
    expect(screen.getByText(/src — 2 items/)).toBeTruthy()
    expect(container.querySelector('[data-tool-body="list_dir"]')).toBeTruthy()

    const listing = container.querySelector('[data-dir-listing]')
    expect(listing).toBeTruthy()
    expect(listing?.className).not.toMatch(/max-h-/)
    expect(listing?.className).not.toMatch(/overflow-auto|overflow-y-auto/)
    expect(listing?.className).toMatch(/pr-5/)

    expect(screen.getByText('components/')).toBeTruthy()
    expect(screen.getByText('index.ts')).toBeTruthy()
    expect(screen.getByText('2K')).toBeTruthy()
    expect(screen.getByTitle('Size 2K')).toBeTruthy()
  })

  it('keeps Directory chrome in a group without repeating the path', () => {
    render(
      <ListDirBody
        {...bodyProps}
        inGroup
        tool={tool({
          name: 'list_dir',
          argsPreview: JSON.stringify({ path: 'src' }),
          content: 'Directory: src (1 entries)\n[file] a.ts (100)'
        })}
      />
    )
    expect(screen.getByText('Directory')).toBeTruthy()
    expect(screen.getByText('1 item')).toBeTruthy()
    expect(screen.queryByText(/src —/)).toBeNull()
  })
})

describe('DirListing', () => {
  it('omits empty size cells so the right gutter stays clear', () => {
    const { container } = render(
      <DirListing
        entries={[
          { kind: 'dir', name: 'docs', size: '' },
          { kind: 'file', name: 'a.ts', size: '8K' }
        ]}
      />
    )
    const listing = container.querySelector('[data-dir-listing]')
    expect(listing).toBeTruthy()
    expect(screen.getByText('docs/')).toBeTruthy()
    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.getByText('8K')).toBeTruthy()
    expect(screen.queryByTitle('Size ')).toBeNull()
  })
})

describe('SkillBody', () => {
  it('renders skill markdown content', () => {
    render(
      <SkillBody
        {...bodyProps}
        tool={tool({
          name: 'Skill',
          argsPreview: JSON.stringify({ name: 'code-review' }),
          content: '# Skill: code-review\n\nReview code carefully.'
        })}
      />
    )
    expect(screen.getByText('Skill: code-review')).toBeTruthy()
    expect(screen.getByText('Review code carefully.')).toBeTruthy()
  })

  it('renders directory listings as a path list', () => {
    render(
      <SkillBody
        {...bodyProps}
        tool={tool({
          name: 'Skill',
          argsPreview: JSON.stringify({ name: 'code-review', path: 'docs' }),
          content: 'Directory: docs\n- docs/a.md\n- docs/b.md'
        })}
      />
    )
    expect(screen.getByText('docs/a.md')).toBeTruthy()
    expect(screen.getByText('docs/b.md')).toBeTruthy()
    expect(screen.getByText('2 files')).toBeTruthy()
  })

  it('renders failures as raw muted text', () => {
    render(
      <SkillBody
        {...bodyProps}
        tool={tool({
          name: 'Skill',
          status: 'fail',
          content: 'Unknown or disabled skill/plugin-rule: nope.'
        })}
      />
    )
    expect(screen.getByText('Unknown or disabled skill/plugin-rule: nope.')).toBeTruthy()
  })
})

describe('McpPinBody', () => {
  it('renders pinned sections, counts, filter chip, and guidance note', () => {
    render(
      <McpPinBody
        {...bodyProps}
        tool={tool({
          name: 'request_mcp_tools',
          argsPreview: JSON.stringify({ serverId: 'gh' }),
          content: [
            'Pinned for next step (2): mcp__gh__list_issues, mcp__gh__create_issue',
            'Already pinned: mcp__gh__get_issue',
            'Unknown / unresolved: nope',
            'Definitions are append-admitted into the sticky catalog on the next model step (prior tool order kept). Idle pins may later unload (TTL / soft max); call release_mcp_tools when done.'
          ].join('\n')
        })}
      />
    )
    expect(screen.getByText('gh')).toBeTruthy()
    expect(screen.getByText('2 pinned')).toBeTruthy()
    expect(screen.getByText(/Pinned for next step/)).toBeTruthy()
    expect(screen.getByText(/Already pinned/)).toBeTruthy()
    expect(screen.getByText(/Unknown \/ unresolved/)).toBeTruthy()
    expect(screen.getByText('mcp__gh__list_issues')).toBeTruthy()
    expect(screen.getByText('mcp__gh__get_issue')).toBeTruthy()
    expect(screen.getByText('nope')).toBeTruthy()
    expect(screen.getByText(/append-admitted/)).toBeTruthy()
  })

  it('renders release output', () => {
    render(
      <McpPinBody
        {...bodyProps}
        tool={tool({
          name: 'release_mcp_tools',
          argsPreview: JSON.stringify({ tools: ['mcp__gh__a'] }),
          content: [
            'Released (1): mcp__gh__a',
            'Schemas drop from the sticky catalog on the next model step. Re-pin with request_mcp_tools if needed.'
          ].join('\n')
        })}
      />
    )
    // Filter chip and released-name chip both carry the tool name.
    expect(screen.getAllByText('mcp__gh__a')).toHaveLength(2)
    expect(screen.getByText('1 released')).toBeTruthy()
    expect(screen.getByText(/Schemas drop/)).toBeTruthy()
  })

  it('renders no-op output as text', () => {
    render(
      <McpPinBody
        {...bodyProps}
        tool={tool({ name: 'request_mcp_tools', content: 'No new tools pinned.' })}
      />
    )
    expect(screen.getByText('No new tools pinned.')).toBeTruthy()
  })

  it('falls back to raw text for unknown formats', () => {
    render(
      <McpPinBody
        {...bodyProps}
        tool={tool({
          name: 'request_mcp_tools',
          status: 'fail',
          content: 'request_mcp_tools requires an active agent run.'
        })}
      />
    )
    expect(screen.getByText('request_mcp_tools requires an active agent run.')).toBeTruthy()
  })
})
