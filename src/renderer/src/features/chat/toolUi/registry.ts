import type { ComponentType } from 'react'
import type { UiToolRow } from '@shared/transcript'
import { isUnresolvedToolName, summarizeToolArgs } from '@shared/toolSummary'
import { formatPathLabel } from '@shared/utils/displayPath'
import { basename } from '@shared/utils/path'
import {
  BrowserActionBody,
  BrowserSnapshotBody,
  BrowserTabsBody
} from './bodies/BrowserBody'
import { DeleteBody } from './bodies/DeleteBody'
import { DiagnosticsBody } from './bodies/DiagnosticsBody'
import { EditBody, MultiEditBody } from './bodies/EditBody'
import { GitCommitBody, GitDiffBody, GitStatusBody } from './bodies/GitBody'
import { GlobBody } from './bodies/GlobBody'
import { GrepBody } from './bodies/GrepBody'
import { ListDirBody } from './bodies/ListDirBody'
import { FallbackBody, McpBody } from './bodies/McpBody'
import { McpIntrospectBody } from './bodies/McpIntrospectBody'
import { McpPinBody } from './bodies/McpPinBody'
import { MemoryListBody, MemoryReadBody, MemoryWriteBody } from './bodies/MemoryBodies'
import { ReadBody } from './bodies/ReadBody'
import { SearchBody } from './bodies/SearchBody'
import { SkillBody } from './bodies/SkillBody'
import { StatusMessageBody } from './bodies/StatusMessageBody'
import { TerminalBody } from './bodies/TerminalBody'
import { TodoBody } from './bodies/TodoBody'
import { WebFetchBody } from './bodies/WebFetchBody'
import { WebSearchBody } from './bodies/WebSearchBody'
import { GenerateImageBody } from './bodies/GenerateImageBody'
import { isInterruptedToolContent, isMcpTool, toolIconName, toolLabel } from './meta'
import {
  parseBrowserActionData,
  parseBrowserSnapshotData,
  parseBrowserTabsData
} from './parsers/browser'
import { parseDeleteData } from './parsers/delete'
import { parseDiagnosticsData } from './parsers/diagnostics'
import { parseDiffPreview, parseEditCardData } from './parsers/edit'
import { parseGitCommitData, parseGitDiffData, parseGitStatusData } from './parsers/git'
import { parseMcpIntrospectData } from './parsers/mcpIntrospect'
import { parseMcpPinData } from './parsers/mcpPin'
import { parseReadData } from './parsers/read'
import { parseStatusMessageData } from './parsers/status'
import { parseTodoData } from './parsers/todo'
import { formatTerminalHeaderTarget, parseTerminalCardData } from './parsers/terminal'
import { parseGenerateImageData } from './parsers/generateImage'
import type { ToolBodyProps, ToolHeaderMeta } from './types'

type ToolBodyCtx = {
  toolProgress?: ToolBodyProps['toolProgress']
}

export type ToolRegistryEntry = {
  Body: ComponentType<ToolBodyProps>
  hasBody: (tool: UiToolRow, ctx?: ToolBodyCtx) => boolean
  headerMeta?: (tool: UiToolRow, ctx?: ToolBodyCtx) => ToolHeaderMeta
}

function editHasBody(tool: UiToolRow): boolean {
  return parseDiffPreview(tool).length > 0 || Boolean((tool.content ?? '').trim())
}

function terminalHasBody(tool: UiToolRow): boolean {
  const data = parseTerminalCardData(tool)
  // Command alone is enough — show `$ …` in the fixed viewport before streams arrive.
  return Boolean(data.command || data.output || data.stderr || data.cwd || data.shell)
}

function todoHasBody(tool: UiToolRow): boolean {
  return parseTodoData(tool).items.length > 0
}

function gitStatusHasBody(tool: UiToolRow): boolean {
  const data = parseGitStatusData(tool)
  return Boolean(data.message || data.branch || data.files.length > 0 || tool.content)
}

function gitDiffHasBody(tool: UiToolRow): boolean {
  const data = parseGitDiffData(tool)
  return data.lines.length > 0 || Boolean(data.message || tool.content)
}

function gitCommitHasBody(tool: UiToolRow): boolean {
  const data = parseGitCommitData(tool)
  return Boolean(data.message || data.hash || data.detail || data.summary || tool.content)
}

function deleteHasBody(tool: UiToolRow): boolean {
  const data = parseDeleteData(tool)
  return Boolean(data.message || data.path)
}

function contentHasBody(tool: UiToolRow): boolean {
  return Boolean((tool.content ?? '').trim())
}

function defaultHasBody(tool: UiToolRow): boolean {
  return Boolean(tool.content || tool.argsPreview)
}

function browserSnapshotHasBody(tool: UiToolRow): boolean {
  const data = parseBrowserSnapshotData(tool)
  return Boolean(data.url || data.refs.length > 0 || data.body || data.message || tool.content)
}

function browserTabsHasBody(tool: UiToolRow): boolean {
  const data = parseBrowserTabsData(tool)
  return Boolean(data.tabs.length > 0 || data.message || tool.content)
}

function browserActionHasBody(tool: UiToolRow): boolean {
  const data = parseBrowserActionData(tool)
  return Boolean(data.message || data.target)
}

function diagnosticsHasBody(tool: UiToolRow): boolean {
  const data = parseDiagnosticsData(tool)
  return Boolean(
    data.issues.length > 0 || data.rawLines.length > 0 || data.message || data.command || tool.content
  )
}

function mcpIntrospectHasBody(tool: UiToolRow): boolean {
  const data = parseMcpIntrospectData(tool)
  return Boolean(
    data.tools.length > 0 ||
      data.entries.length > 0 ||
      data.blocks.length > 0 ||
      data.text ||
      data.message ||
      tool.content
  )
}

function generateImageHasBody(tool: UiToolRow, ctx?: ToolBodyCtx): boolean {
  return (
    Boolean((tool.content ?? '').trim() || tool.summary) || (ctx?.toolProgress?.length ?? 0) > 0
  )
}

function statusMessageHasBody(tool: UiToolRow): boolean {
  const data = parseStatusMessageData(tool)
  return Boolean(data.message || data.answers.length > 0)
}

function mcpPinHasBody(tool: UiToolRow): boolean {
  const data = parseMcpPinData(tool)
  return Boolean(
    data.sections.length > 0 || data.noneMessage || data.note || data.message || tool.content
  )
}

const browserActionEntry: ToolRegistryEntry = {
  Body: BrowserActionBody,
  hasBody: browserActionHasBody,
  headerMeta: (tool) => {
    const data = parseBrowserActionData(tool)
    return {
      verb: toolLabel(tool.name, tool.status),
      target: data.target || tool.summary,
      icon: 'globe'
    }
  }
}

const generateImageEntry: ToolRegistryEntry = {
  Body: GenerateImageBody,
  hasBody: generateImageHasBody,
  headerMeta: (tool) => {
    const data = parseGenerateImageData(tool)
    return {
      verb: toolLabel(tool.name, tool.status),
      target: data.path || tool.summary,
      icon: 'sparkles'
    }
  }
}

const mcpIntrospectEntry: ToolRegistryEntry = {
  Body: McpIntrospectBody,
  hasBody: mcpIntrospectHasBody,
  headerMeta: (tool) => {
    const data = parseMcpIntrospectData(tool)
    return {
      verb: toolLabel(tool.name, tool.status),
      target: data.filter || tool.summary,
      icon: 'plug'
    }
  }
}

const mcpPinEntry: ToolRegistryEntry = {
  Body: McpPinBody,
  hasBody: mcpPinHasBody,
  headerMeta: (tool) => {
    const data = parseMcpPinData(tool)
    return {
      verb: toolLabel(tool.name, tool.status),
      target: data.filter || tool.summary,
      icon: 'plug'
    }
  }
}

const BUILTIN_REGISTRY: Record<string, ToolRegistryEntry> = {
  read: {
    Body: ReadBody,
    hasBody: defaultHasBody,
    headerMeta: (tool) => {
      const data = parseReadData(tool)
      const name = basename(data.path) || data.path
      const target = data.lineRange ? `${name} ${data.lineRange}` : name
      return {
        verb: toolLabel(tool.name, tool.status),
        target,
        filePath: data.path
      }
    }
  },
  edit: {
    Body: EditBody,
    hasBody: editHasBody,
    headerMeta: (tool) => {
      const edit = parseEditCardData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: basename(edit.path),
        added: edit.added,
        removed: edit.removed,
        filePath: edit.path
      }
    }
  },
  multi_edit: {
    Body: MultiEditBody,
    hasBody: editHasBody,
    headerMeta: (tool) => {
      const edit = parseEditCardData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: edit.path,
        added: edit.added,
        removed: edit.removed,
        filePath: edit.path
      }
    }
  },
  str_replace: {
    Body: EditBody,
    hasBody: editHasBody,
    headerMeta: (tool) => {
      const edit = parseEditCardData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: basename(edit.path),
        added: edit.added,
        removed: edit.removed,
        filePath: edit.path
      }
    }
  },
  search: {
    Body: SearchBody,
    hasBody: defaultHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'fileSearch'
    })
  },
  glob: {
    Body: GlobBody,
    hasBody: defaultHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'folderSearch'
    })
  },
  grep: {
    Body: GrepBody,
    hasBody: defaultHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'scanSearch'
    })
  },
  list_dir: {
    Body: ListDirBody,
    hasBody: defaultHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'folderOpen'
    })
  },
  delete: {
    Body: DeleteBody,
    hasBody: deleteHasBody,
    headerMeta: (tool) => {
      const data = parseDeleteData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: basename(data.path),
        icon: 'trash'
      }
    }
  },
  todo_write: {
    Body: TodoBody,
    hasBody: todoHasBody,
    headerMeta: (tool) => {
      const data = parseTodoData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: data.total > 0 ? `${data.done}/${data.total} complete` : tool.summary,
        icon: 'listTodo'
      }
    }
  },
  web_fetch: {
    Body: WebFetchBody,
    hasBody: defaultHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'globe'
    })
  },
  web_search: {
    Body: WebSearchBody,
    hasBody: defaultHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'globe'
    })
  },
  git_status: {
    Body: GitStatusBody,
    hasBody: gitStatusHasBody,
    headerMeta: (tool) => {
      const data = parseGitStatusData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: data.branch || tool.summary,
        icon: 'branch'
      }
    }
  },
  git_diff: {
    Body: GitDiffBody,
    hasBody: gitDiffHasBody,
    headerMeta: (tool) => {
      const data = parseGitDiffData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: data.path || tool.summary,
        added: data.added,
        removed: data.removed,
        icon: 'branch',
        ...(data.path ? { filePath: data.path } : {})
      }
    }
  },
  git_commit: {
    Body: GitCommitBody,
    hasBody: gitCommitHasBody,
    headerMeta: (tool) => {
      const data = parseGitCommitData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: data.message || data.hash || tool.summary,
        icon: 'branch'
      }
    }
  },
  terminal: {
    Body: TerminalBody,
    hasBody: terminalHasBody,
    headerMeta: (tool) => {
      const data = parseTerminalCardData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: formatTerminalHeaderTarget(data, tool.summary),
        icon: 'terminal',
        exitCode: data.exitCode
      }
    }
  },
  memory_list: {
    Body: MemoryListBody,
    hasBody: defaultHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'memory'
    })
  },
  memory_read: {
    Body: MemoryReadBody,
    hasBody: defaultHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'memory'
    })
  },
  memory_write: {
    Body: MemoryWriteBody,
    hasBody: defaultHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'memory'
    })
  },
  browser_navigate: browserActionEntry,
  browser_click: browserActionEntry,
  browser_type: browserActionEntry,
  browser_scroll: browserActionEntry,
  browser_fill: browserActionEntry,
  browser_back: browserActionEntry,
  browser_forward: browserActionEntry,
  browser_wait_for_selector: browserActionEntry,
  browser_wait_for_url: browserActionEntry,
  browser_press_key: browserActionEntry,
  browser_select_option: browserActionEntry,
  browser_snapshot: {
    Body: BrowserSnapshotBody,
    hasBody: browserSnapshotHasBody,
    headerMeta: (tool) => {
      const data = parseBrowserSnapshotData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: data.title || data.url || tool.summary,
        icon: 'globe'
      }
    }
  },
  browser_tabs: {
    Body: BrowserTabsBody,
    hasBody: browserTabsHasBody,
    headerMeta: (tool) => {
      const data = parseBrowserTabsData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: data.action || tool.summary,
        icon: 'globe'
      }
    }
  },
  diagnostics: {
    Body: DiagnosticsBody,
    hasBody: diagnosticsHasBody,
    headerMeta: (tool) => {
      const data = parseDiagnosticsData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: data.kind || tool.summary,
        icon: 'scanSearch'
      }
    }
  },
  generate_image: generateImageEntry,
  edit_image: generateImageEntry,
  Skill: {
    Body: SkillBody,
    hasBody: defaultHasBody,
    headerMeta: (tool) => ({
      verb: toolLabel(tool.name, tool.status),
      target: tool.summary,
      icon: 'sparkles'
    })
  },
  request_mcp_tools: mcpPinEntry,
  release_mcp_tools: mcpPinEntry,
  mcp_list_tools: mcpIntrospectEntry,
  mcp_list_resources: mcpIntrospectEntry,
  mcp_read_resource: mcpIntrospectEntry,
  mcp_list_prompts: mcpIntrospectEntry,
  mcp_get_prompt: mcpIntrospectEntry,
  ask_question: {
    Body: StatusMessageBody,
    hasBody: statusMessageHasBody,
    headerMeta: (tool) => {
      const data = parseStatusMessageData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: data.chip || tool.summary,
        icon: 'sparkles'
      }
    }
  },
  switch_mode: {
    Body: StatusMessageBody,
    hasBody: statusMessageHasBody,
    headerMeta: (tool) => {
      const data = parseStatusMessageData(tool)
      return {
        verb: toolLabel(tool.name, tool.status),
        target: data.chip || tool.summary,
        icon: 'bot'
      }
    }
  }
}

const MCP_ENTRY: ToolRegistryEntry = {
  Body: McpBody,
  hasBody: contentHasBody,
  headerMeta: (tool) => ({
    verb: toolLabel(tool.name, tool.status),
    target: tool.summary,
    icon: 'plug'
  })
}

const FALLBACK_ENTRY: ToolRegistryEntry = {
  Body: FallbackBody,
  hasBody: contentHasBody
}

export function getToolEntry(name: string): ToolRegistryEntry {
  if (isMcpTool(name)) return MCP_ENTRY
  return BUILTIN_REGISTRY[name] ?? FALLBACK_ENTRY
}

export function getToolBody(name: string): ComponentType<ToolBodyProps> {
  return getToolEntry(name).Body
}

export function toolHasBody(tool: UiToolRow, ctx?: ToolBodyCtx): boolean {
  // Nameless streaming deltas must not expand FallbackBody with raw args JSON.
  if (isUnresolvedToolName(tool.name)) return false
  if (tool.status === 'running') {
    // Prefer per-tool body logic when ctx carries progress state; fall
    // back to args/summary/content for generic running tools.
    if (getToolEntry(tool.name).hasBody(tool, ctx)) return true
    return Boolean(tool.argsPreview?.trim() || tool.summary?.trim() || tool.content?.trim())
  }
  return getToolEntry(tool.name).hasBody(tool, ctx)
}

export function getToolHeaderMeta(tool: UiToolRow, ctx?: ToolBodyCtx): ToolHeaderMeta {
  if (isUnresolvedToolName(tool.name)) {
    return {
      verb: toolLabel(tool.name, tool.status, tool.content),
      target: '',
      icon: toolIconName(tool.name)
    }
  }
  const entry = getToolEntry(tool.name)
  const meta = entry.headerMeta
    ? entry.headerMeta(tool, ctx)
    : {
        verb: toolLabel(tool.name, tool.status, tool.content),
        target: tool.summary || summarizeToolArgs(tool.name, tool.argsPreview),
        icon: toolIconName(tool.name)
      }
  // Registry headerMeta often keys only on status; align interrupted verbs.
  if (isInterruptedToolContent(tool.content) && tool.status !== 'running') {
    return { ...meta, verb: toolLabel(tool.name, 'running') }
  }
  return meta
}
