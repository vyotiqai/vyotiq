/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { UserPrompt } from '@renderer/features/chat/components/UserPrompt'
import {
  formatMcpToolInvocation,
  formatSkillInvocation
} from '@shared/slashCommands'
import type { UserItem } from '@renderer/features/chat/utils/transcriptRows'

describe('UserPrompt slash chips', () => {
  it('renders a skill chip and user request without the skill body', () => {
    const content = formatSkillInvocation(
      'code-review',
      '## Full skill body that must stay hidden',
      'Please review the auth module'
    )
    const item: UserItem = {
      kind: 'user',
      id: 'u1',
      content,
      messageIndex: 0
    }
    render(<UserPrompt item={item} onImageClick={() => {}} />)
    expect(screen.getByTitle('Skill: code-review')).toBeTruthy()
    expect(screen.getByText('code-review')).toBeTruthy()
    expect(screen.getByText(/Please review the auth module/)).toBeTruthy()
    expect(screen.queryByText(/Full skill body/)).toBeNull()
  })

  it('renders an MCP chip and user request without the tool description dump', () => {
    const content = formatMcpToolInvocation(
      'docs',
      'search',
      'Search the docs corpus',
      'find auth setup'
    )
    const item: UserItem = {
      kind: 'user',
      id: 'u2',
      content,
      messageIndex: 0
    }
    render(<UserPrompt item={item} onImageClick={() => {}} />)
    expect(screen.getByTitle('MCP: docs-search')).toBeTruthy()
    expect(screen.getByText('docs-search')).toBeTruthy()
    expect(screen.getByText(/find auth setup/)).toBeTruthy()
    expect(screen.queryByText(/Search the docs corpus/)).toBeNull()
  })
})
