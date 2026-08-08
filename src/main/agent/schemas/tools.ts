import { z, type ZodTypeAny } from 'zod'
import { TERMINAL_MAX_TIMEOUT_MS } from '../tools/terminal'
import { USER_REGEX_MAX_LENGTH } from '../tools/safeUserRegex'
import {
  AGENT_QUESTION_MAX_ITEMS,
  AGENT_QUESTION_MAX_OPTIONS,
  AGENT_QUESTION_MAX_OPTION_CHARS,
  AGENT_QUESTION_MAX_PROMPT_CHARS,
  AGENT_QUESTION_MAX_TITLE_CHARS
} from '../../../shared/utils/agentQuestionForm'
import type { ToolDefinition } from '../providers/types'
import { zodToJsonSchema } from './zodToJsonSchema'

const readArgs = z
  .object({
    path: z.string().describe('Relative or absolute path inside the workspace'),
    startLine: z
      .number()
      .int()
      .min(1)
      .describe('First line to return, 1-based inclusive. Prefer this over offset/limit.')
      .optional(),
    endLine: z
      .number()
      .int()
      .min(1)
      .describe('Last line to return, 1-based inclusive. Defaults to end of file.')
      .optional(),
    offset: z
      .number()
      .min(0)
      .describe('Byte offset; only for files too large to slice by line')
      .optional(),
    limit: z.number().min(1).describe('Max bytes to read from offset').optional()
  })
  .strict()
  .refine(
    (args) =>
      args.startLine == null || args.endLine == null || args.endLine >= args.startLine,
    { message: 'endLine must be >= startLine', path: ['endLine'] }
  )

const editArgs = z
  .object({
    path: z.string().describe('File path inside the workspace'),
    contents: z
      .string()
      .describe('Full file contents to write (prefer for new/small files). Mutually exclusive with diff.')
      .optional(),
    diff: z
      .string()
      .describe('Unified diff with @@ hunks (use when editing an existing file without rewriting it). Mutually exclusive with contents.')
      .optional()
  })
  .strict()
  .refine(
    (args) =>
      typeof args.contents === 'string' ||
      (typeof args.diff === 'string' && args.diff.trim().length > 0),
    { message: 'edit requires contents or diff' }
  )
  .refine(
    (args) => !(typeof args.contents === 'string' && typeof args.diff === 'string' && args.diff.trim()),
    { message: 'edit accepts contents or diff, not both', path: ['diff'] }
  )

const searchArgs = z
  .object({
    query: z
      .string()
      .max(USER_REGEX_MAX_LENGTH)
      .describe(
        `Filename fragment or content substring (or regex when regex=true, max ${USER_REGEX_MAX_LENGTH} chars)`
      ),
    maxResults: z
      .number()
      .int()
      .min(1)
      .describe('Max hits (default 40)')
      .optional(),
    regex: z
      .boolean()
      .describe('Treat query as case-insensitive regex (default false)')
      .optional()
  })
  .strict()

/** Drop session_id when a command is also present (poll footgun; includes invented UUIDs). */
function coerceTerminalSessionId(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const v = raw as Record<string, unknown>
  const sid = typeof v.session_id === 'string' ? v.session_id.trim() : ''
  const cmd = typeof v.command === 'string' ? v.command.trim() : ''
  if (sid && cmd) {
    const { session_id: _drop, ...rest } = v
    return rest
  }
  return raw
}

const terminalArgs = z.preprocess(
  coerceTerminalSessionId,
  z
    .object({
      command: z
        .string()
        .describe(
          'Shell command to run at workspace root. Required to start; omit when polling an existing session_id. Shell comes from Settings → Agent → Terminal shell.'
        )
        .optional(),
      working_directory: z
        .string()
        .describe(
          'Optional subdirectory inside the workspace for cwd (default: workspace root). Must resolve inside the workspace.'
        )
        .optional(),
      session_id: z
        .string()
        .uuid()
        .describe(
          'Only the session_id UUID from a prior terminal tool result (background start). Never invent labels; omit session_id and pass command for a new shell.'
        )
        .optional(),
      block_until_ms: z
        .number()
        .int()
        .min(0)
        .max(TERMINAL_MAX_TIMEOUT_MS)
        .describe(
          'How long to wait before returning (default: full timeout for foreground; use 0 to start background immediately). When polling an existing session_id, wait up to this many ms for exit or pattern (default 30000 when omitted).'
        )
        .optional(),
      pattern: z
        .string()
        .max(USER_REGEX_MAX_LENGTH)
        .describe(
          `Optional regex matched against combined stdout+stderr; return early when matched (max ${USER_REGEX_MAX_LENGTH} chars)`
        )
        .optional(),
      timeoutMs: z
        .number()
        .int()
        .min(1)
        .max(TERMINAL_MAX_TIMEOUT_MS)
        .describe(
          `Foreground timeout in ms when block_until_ms is omitted (default 60000, max ${TERMINAL_MAX_TIMEOUT_MS})`
        )
        .optional()
    })
    .strict()
    .refine((v) => Boolean(v.command?.trim()) || Boolean(v.session_id?.trim()), {
      message: 'Provide command to start a shell, or session_id to poll one'
    })
)

const gitCommitArgs = z
  .object({
    message: z.string().min(1).describe('Commit message'),
    push: z
      .boolean()
      .describe('Also push to origin after commit (default false)')
      .optional(),
    paths: z
      .array(z.string().min(1))
      .describe(
        'Extra workspace-relative paths to include beyond files this run changed (e.g. terminal-generated outputs)'
      )
      .optional()
  })
  .strict()

const globArgs = z
  .object({
    pattern: z
      .string()
      .describe('Glob over workspace-relative paths, e.g. src/**/*.ts or **/{README,LICENSE}*'),
    maxResults: z
      .number()
      .int()
      .min(1)
      .describe('Max paths to return (default 100)')
      .optional()
  })
  .strict()

const grepArgs = z
  .object({
    pattern: z
      .string()
      .max(USER_REGEX_MAX_LENGTH)
      .describe(`Regular expression matched against each line (max ${USER_REGEX_MAX_LENGTH} chars)`),
    include: z
      .string()
      .describe('Glob limiting which files are searched, e.g. src/**/*.ts')
      .optional(),
    caseSensitive: z.boolean().describe('Case-sensitive match (default false)').optional(),
    contextLines: z
      .number()
      .int()
      .min(0)
      .max(5)
      .describe('Lines of context around each hit (default 0, max 5)')
      .optional(),
    maxResults: z
      .number()
      .int()
      .min(1)
      .describe('Max matching lines (default 60)')
      .optional()
  })
  .strict()

const listDirArgs = z
  .object({
    path: z
      .string()
      .describe('Workspace-relative directory (default workspace root)')
      .optional()
  })
  .strict()

const multiEditArgs = z
  .object({
    edits: z
      .array(
        z
          .object({
            path: z.string().describe('File path inside the workspace'),
            contents: z
              .string()
              .describe('Full file contents to write')
              .optional(),
            diff: z
              .string()
              .describe('Unified diff to apply instead of full contents')
              .optional()
          })
          .strict()
          .refine(
            (args) =>
              typeof args.contents === 'string' ||
              (typeof args.diff === 'string' && args.diff.trim().length > 0),
            { message: 'each edit requires contents or diff' }
          )
      )
      .min(1)
      .superRefine((edits, ctx) => {
        const seen = new Set<string>()
        for (let i = 0; i < edits.length; i++) {
          const path = edits[i]?.path?.trim()
          if (!path) continue
          const key = path.replace(/\\/g, '/').toLowerCase()
          if (seen.has(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `duplicate path "${edits[i]!.path}" — combine into one edit`,
              path: [i, 'path']
            })
          }
          seen.add(key)
        }
      })
      .describe(
        'Edits applied together atomically; if any fails, none are written. Do not list the same path twice.'
      )
  })
  .strict()

const deleteArgs = z
  .object({
    path: z.string().describe('File or directory inside the workspace'),
    recursive: z
      .boolean()
      .describe('Required to delete a non-empty directory')
      .optional()
  })
  .strict()

const todoWriteArgs = z
  .object({
    todos: z
      .array(
        z
          .object({
            id: z.string().min(1).describe('Stable id so status updates can find the task again'),
            content: z.string().min(1).describe('What the task is'),
            status: z
              .enum(['pending', 'in_progress', 'completed', 'cancelled'])
              .describe('Task status: pending, in_progress, completed, or cancelled.')
          })
          .strict()
      )
      .describe('The full task list, or the subset to update when merge=true'),
    merge: z
      .boolean()
      .describe('Merge these entries into the existing list instead of replacing it')
      .optional()
  })
  .strict()
  .refine((args) => args.merge === true || args.todos.length > 0, {
    message: 'todos must be non-empty unless merge=true',
    path: ['todos']
  })

const browserSearchArgs = z
  .object({
    query: z.string().min(1).describe('Search query string.'),
    maxChars: z
      .number()
      .int()
      .min(1000)
      .describe('Cap on snapshot text (default 40000)')
      .optional(),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .describe('Navigation timeout in ms (default 30000)')
      .optional()
  })
  .strict()

const browserTabIdArg = z
  .string()
  .min(1)
  .describe('Optional tab id from browser_tabs / navigate (default: active tab)')
  .optional()

const browserSettleMsArg = z
  .number()
  .int()
  .min(0)
  .describe('Post-action settle wait in ms (default 400)')
  .optional()

const browserNavigateArgs = z
  .object({
    url: z
      .string()
      .describe('Absolute http(s) URL to open in the built-in agent browser.'),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .describe('Navigation timeout in ms (default 30000)')
      .optional(),
    tab_id: browserTabIdArg
  })
  .strict()

const browserSnapshotArgs = z
  .object({
    maxChars: z
      .number()
      .int()
      .min(1000)
      .describe('Cap on returned page text (default 40000)')
      .optional(),
    tab_id: browserTabIdArg
  })
  .strict()

const browserClickArgs = z
  .object({
    selector: z
      .string()
      .min(1)
      .describe('CSS selector or snapshot ref (@e12) from the latest browser_snapshot.'),
    button: z
      .enum(['left', 'right', 'middle'])
      .describe('Mouse button (default left)')
      .optional(),
    tab_id: browserTabIdArg,
    settleMs: browserSettleMsArg
  })
  .strict()

const browserTypeArgs = z
  .object({
    text: z.string().describe('Text to type into the focused (or selected) element.'),
    selector: z
      .string()
      .min(1)
      .describe('Optional CSS selector or snapshot ref (@e12) to focus before typing')
      .optional(),
    clear: z.boolean().describe('Select-all and delete before typing (default false)').optional(),
    pressEnter: z.boolean().describe('Press Enter after typing (default false)').optional(),
    tab_id: browserTabIdArg,
    settleMs: browserSettleMsArg
  })
  .strict()

const browserScrollArgs = z
  .object({
    selector: z
      .string()
      .min(1)
      .describe('Optional CSS selector or @eN ref to scroll into view')
      .optional(),
    deltaX: z.number().describe('Horizontal scroll delta in pixels').optional(),
    deltaY: z.number().describe('Vertical scroll delta in pixels').optional(),
    tab_id: browserTabIdArg,
    settleMs: browserSettleMsArg
  })
  .strict()

const browserFillArgs = z
  .object({
    selector: z
      .string()
      .min(1)
      .describe('CSS selector or snapshot ref (@e12) of an input, textarea, or contenteditable.'),
    value: z.string().describe('Full value to set (replaces existing content).'),
    pressEnter: z.boolean().describe('Press Enter after filling (default false)').optional(),
    tab_id: browserTabIdArg,
    settleMs: browserSettleMsArg
  })
  .strict()

const browserTabsArgs = z
  .object({
    action: z.enum(['list', 'open', 'close', 'select']).describe('Tab action to perform'),
    tab_id: browserTabIdArg,
    url: z
      .string()
      .describe('Optional URL to load when action is open')
      .optional()
  })
  .strict()

const browserBackArgs = z.object({ tab_id: browserTabIdArg }).strict()
const browserForwardArgs = z.object({ tab_id: browserTabIdArg }).strict()

const browserWaitForSelectorArgs = z
  .object({
    selector: z.string().min(1).describe('CSS selector or @eN ref to wait for'),
    timeoutMs: z.number().int().min(100).describe('Wait timeout in ms (default 15000)').optional(),
    tab_id: browserTabIdArg
  })
  .strict()

const browserWaitForUrlArgs = z
  .object({
    match: z.string().min(1).describe('Substring or regex pattern the page URL must match'),
    regex: z.boolean().describe('Treat match as a regex (default false)').optional(),
    timeoutMs: z.number().int().min(100).describe('Wait timeout in ms (default 15000)').optional(),
    tab_id: browserTabIdArg
  })
  .strict()

const browserPressKeyArgs = z
  .object({
    key: z.string().min(1).describe('Key code to press (e.g. Enter, Escape, Tab, a)'),
    modifiers: z
      .array(z.string())
      .describe('Optional modifiers: control, shift, alt, meta')
      .optional(),
    tab_id: browserTabIdArg,
    settleMs: browserSettleMsArg
  })
  .strict()

const browserSelectOptionArgs = z
  .object({
    selector: z.string().min(1).describe('CSS selector or @eN ref of a <select>'),
    value: z.string().describe('Option value to select').optional(),
    label: z.string().describe('Option visible label to select').optional(),
    pressEnter: z.boolean().describe('Press Enter after selecting (default false)').optional(),
    tab_id: browserTabIdArg,
    settleMs: browserSettleMsArg
  })
  .strict()
  .refine((v) => Boolean(v.value?.trim()) || Boolean(v.label?.trim()), {
    message: 'Provide value or label for browser_select_option'
  })

const mcpListToolsArgs = z
  .object({
    serverId: z
      .string()
      .describe('Optional MCP server id filter (exact match on server id)')
      .optional(),
    server_id: z
      .string()
      .describe('Deprecated alias for serverId')
      .optional()
  })
  .strict()

const requestMcpToolsArgs = z
  .object({
    tools: z
      .array(z.string().min(1).max(200))
      .max(32)
      .describe(
        'Full MCP tool names (mcp__server__tool) and/or bare tool names to pin for the next step'
      )
      .optional(),
    serverId: z
      .string()
      .describe('Pin every connected tool from this MCP server id for the next step')
      .optional(),
    server_id: z.string().describe('Deprecated alias for serverId').optional()
  })
  .strict()

const releaseMcpToolsArgs = z
  .object({
    tools: z
      .array(z.string().min(1).max(200))
      .max(32)
      .describe(
        'Full MCP tool names (mcp__server__tool) and/or bare tool names to release from the sticky catalog'
      )
      .optional(),
    serverId: z
      .string()
      .describe('Release every pinned tool from this MCP server id')
      .optional(),
    server_id: z.string().describe('Deprecated alias for serverId').optional()
  })
  .strict()

const mcpListResourcesArgs = z
  .object({
    serverId: z
      .string()
      .describe('Optional MCP server id (omit to list all connected enabled servers)')
      .optional(),
    server_id: z
      .string()
      .describe('Deprecated alias for serverId')
      .optional()
  })
  .strict()

const mcpReadResourceArgs = z
  .object({
    serverId: z.string().min(1).describe('MCP server id'),
    uri: z.string().min(1).describe('Resource URI to read')
  })
  .strict()

const mcpListPromptsArgs = z
  .object({
    serverId: z
      .string()
      .describe('Optional MCP server id (omit to list all connected enabled servers)')
      .optional(),
    server_id: z
      .string()
      .describe('Deprecated alias for serverId')
      .optional()
  })
  .strict()

const mcpGetPromptArgs = z
  .object({
    serverId: z.string().min(1).describe('MCP server id'),
    name: z.string().min(1).describe('Prompt name'),
    arguments: z
      .record(z.string(), z.string())
      .describe('Prompt argument values')
      .optional()
  })
  .strict()

const strReplaceArgs = z
  .object({
    path: z.string().describe('File path inside the workspace'),
    old_string: z
      .string()
      .min(1)
      .describe('Exact text to find. Must be unique in the file unless replace_all is true.'),
    new_string: z.string().describe('Replacement text (may be empty to delete the match)'),
    replace_all: z
      .boolean()
      .describe('Replace every occurrence (default false — fails if old_string matches more than once)')
      .optional()
  })
  .strict()

const askQuestionItemArgs = z
  .object({
    id: z.string().min(1).describe('Stable id used to match the answer'),
    prompt: z
      .string()
      .min(1)
      .max(AGENT_QUESTION_MAX_PROMPT_CHARS)
      .describe('Question text shown to the user'),
    type: z
      .enum(['single', 'multi', 'boolean', 'text'])
      .describe('single=one option; multi=many; boolean=yes/no; text=freeform'),
    options: z
      .array(z.string().min(1).max(AGENT_QUESTION_MAX_OPTION_CHARS))
      .min(2)
      .max(AGENT_QUESTION_MAX_OPTIONS)
      .describe('Required for single/multi (at least 2 choices)')
      .optional(),
    allowCustom: z
      .boolean()
      .describe('For single/multi, allow an Other… text answer (default false)')
      .optional()
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.type === 'single' || item.type === 'multi') {
      if (!item.options || item.options.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${item.type} requires at least 2 options`,
          path: ['options']
        })
      }
    }
  })

const askQuestionArgs = z
  .object({
    title: z
      .string()
      .min(1)
      .max(AGENT_QUESTION_MAX_TITLE_CHARS)
      .describe('Optional form title when asking multiple questions')
      .optional(),
    questions: z
      .array(askQuestionItemArgs)
      .min(1)
      .max(AGENT_QUESTION_MAX_ITEMS)
      .describe('Typed question form (1–8 items). Prefer this over legacy fields.')
      .optional(),
    question: z
      .string()
      .min(1)
      .max(AGENT_QUESTION_MAX_PROMPT_CHARS)
      .describe('Legacy single-question text when questions[] is omitted')
      .optional(),
    options: z
      .array(z.string().min(1).max(AGENT_QUESTION_MAX_OPTION_CHARS))
      .max(AGENT_QUESTION_MAX_OPTIONS)
      .describe('Legacy fixed choices for a single question')
      .optional(),
    allowMultiple: z
      .boolean()
      .describe('Legacy: allow selecting more than one option (default false)')
      .optional(),
    allowCustom: z
      .boolean()
      .describe('Legacy: allow a custom text answer with options (default true)')
      .optional()
  })
  .strict()
  .superRefine((val, ctx) => {
    if ((!val.questions || val.questions.length === 0) && !val.question?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide questions[] or question'
      })
    }
  })

const switchModeArgs = z
  .object({
    mode: z
      .enum(['ask', 'plan', 'agent'])
      .describe('Target interaction mode for the rest of this run')
  })
  .strict()

const memoryListArgs = z.object({}).strict()

const memoryReadArgs = z
  .object({
    path: z
      .string()
      .describe(
        'Relative path inside .vyotiq/memory: index.md | state.md | notes/<name>.md'
      )
  })
  .strict()

const memoryWriteArgs = z
  .object({
    path: z
      .string()
      .describe(
        'Relative path inside .vyotiq/memory: index.md | state.md | notes/<name>.md'
      ),
    contents: z
      .string()
      .describe('Full markdown contents to write. Never store secrets.')
  })
  .strict()

const gitStatusArgs = z.object({}).strict()

const gitDiffArgs = z
  .object({
    path: z
      .string()
      .describe('Optional workspace-relative path to limit the diff')
      .optional(),
    staged: z
      .boolean()
      .describe('When true, show staged (index) diff instead of working tree')
      .optional()
  })
  .strict()

const diagnosticsArgs = z
  .object({
    kind: z
      .enum(['typecheck', 'lint'])
      .describe('typecheck (default) or lint — uses package scripts when present')
      .optional()
  })
  .strict()

const generateImageArgs = z
  .object({
    prompt: z
      .string()
      .min(1)
      .describe('Image generation instruction (scene, subject, style, constraints)'),
    path: z
      .string()
      .describe(
        'Workspace-relative output path (png/jpg/webp/svg). Omit to write under .vyotiq/generated/.'
      )
      .optional(),
    provider: z
      .enum(['openai', 'gemini', 'xai', 'openrouter', 'custom'])
      .describe('Image API provider override (default: Settings → Image provider, then auto by key)')
      .optional(),
    model: z
      .string()
      .describe(
        'Provider image model override (e.g. gpt-image-2, gemini-3.1-flash-image, grok-imagine-image, bytedance-seed/seedream-4.5, dall-e-3 on custom)'
      )
      .optional(),
    preset: z
      .enum(['draft', 'final'])
      .describe(
        'draft = low/1K/speed defaults; final = high/2K/quality. Explicit quality/size/resolution/model win.'
      )
      .optional(),
    size: z
      .string()
      .describe(
        'OpenAI/OpenRouter size WxH or auto (e.g. 1024x1024). OpenAI: edges multiples of 16. Prefer aspect_ratio+resolution for Gemini/xAI/OpenRouter.'
      )
      .optional(),
    quality: z
      .enum(['low', 'medium', 'high', 'auto'])
      .describe('OpenAI/OpenRouter quality; prefer low / preset=draft for drafts')
      .optional(),
    aspect_ratio: z
      .string()
      .describe('Gemini/xAI/OpenRouter aspect ratio (e.g. 1:1, 16:9, 9:16). Prefer over size for those providers.')
      .optional(),
    resolution: z
      .string()
      .describe(
        'Gemini/OpenRouter imageSize (0.5K/1K/2K/4K) or xAI resolution (1k/2k; 4k clamps to 2k)'
      )
      .optional(),
    n: z
      .number()
      .int()
      .min(1)
      .max(4)
      .describe(
        'How many images to generate (OpenAI/xAI/OpenRouter; Gemini returns one). Extra files get -2, -3 suffixes.'
      )
      .optional(),
    output_format: z
      .enum(['png', 'jpeg', 'webp', 'svg'])
      .describe('Output format (default png). svg is OpenRouter vector models only.')
      .optional(),
    output_compression: z
      .number()
      .int()
      .min(0)
      .max(100)
      .describe('jpeg/webp compression 0–100 (OpenAI/OpenRouter)')
      .optional(),
    background: z
      .enum(['opaque', 'transparent', 'auto'])
      .describe('Background. transparent is not supported on gpt-image-2.')
      .optional()
  })
  .strict()

const editImageArgs = z
  .object({
    prompt: z
      .string()
      .min(1)
      .describe(
        'Edit instruction. Prefer “change only X; keep everything else the same.” Reference Image 1…N when multiple.'
      ),
    reference_paths: z
      .array(z.string().min(1))
      .min(1)
      .max(16)
      .describe(
        'Workspace-relative source/reference images (1–16; xAI max 3). First image is the primary canvas.'
      ),
    path: z
      .string()
      .describe(
        'Output path. Omit to overwrite the first reference (iterate in place). Pass a new path to keep the original.'
      )
      .optional(),
    mask_path: z
      .string()
      .describe(
        'Optional OpenAI mask PNG (transparent = editable). Not supported on Gemini/xAI/OpenRouter.'
      )
      .optional(),
    provider: z
      .enum(['openai', 'gemini', 'xai', 'openrouter', 'custom'])
      .describe('Image API provider override')
      .optional(),
    model: z.string().describe('Provider image model override').optional(),
    preset: z.enum(['draft', 'final']).describe('draft | final quality defaults').optional(),
    size: z.string().describe('OpenAI/OpenRouter size WxH or auto').optional(),
    quality: z.enum(['low', 'medium', 'high', 'auto']).describe('OpenAI/OpenRouter quality').optional(),
    aspect_ratio: z.string().describe('Gemini/xAI/OpenRouter aspect ratio').optional(),
    resolution: z.string().describe('Gemini/OpenRouter imageSize or xAI resolution').optional(),
    n: z.number().int().min(1).max(4).describe('OpenAI/xAI/OpenRouter image count').optional(),
    output_format: z
      .enum(['png', 'jpeg', 'webp', 'svg'])
      .describe('Output format (svg = OpenRouter vector models)')
      .optional(),
    output_compression: z.number().int().min(0).max(100).optional(),
    background: z.enum(['opaque', 'transparent', 'auto']).optional()
  })
  .strict()

const skillArgs = z
  .object({
    name: z
      .string()
      .min(1)
      .describe(
        'Skill name from Available skills, or plugin-rule id from Plugin rules (e.g. plugin-rule:quality/rules/quality.md)'
      ),
    path: z
      .string()
      .describe(
        'Optional relative path under the skill root (default: SKILL.md). Use for references/, scripts/, or assets/. Ignored for plugin-rule ids.'
      )
      .optional()
  })
  .strict()

const TOOL_REGISTRY = {
  read: {
    description:
      'Read a file under the workspace root (text only). Directories return a shallow listing.',
    schema: readArgs
  },
  edit: {
    description:
      'Create/overwrite with contents (new or small files), or apply a unified diff. For one exact string change use str_replace; for several files use multi_edit.',
    schema: editArgs
  },
  search: {
    description:
      'Quick filename-or-content substring lookup (first hit per file). Prefer glob for path patterns and grep for every matching line.',
    schema: searchArgs
  },
  glob: {
    description:
      'List workspace-relative paths matching a glob (**, *, ?, {a,b}). Prefer over search when you need paths only. Gitignore-aware.',
    schema: globArgs
  },
  grep: {
    description:
      'Regex search across file contents with every matching line and optional context. Prefer over search when you need all hits or line numbers.',
    schema: grepArgs
  },
  list_dir: {
    description: 'List one directory level with sizes. Gitignore- and build-dir-aware.',
    schema: listDirArgs
  },
  multi_edit: {
    description:
      'Apply several file edits atomically (one entry per path). Prefer when changing multiple files; use str_replace for a single surgical change.',
    schema: multiEditArgs
  },
  str_replace: {
    description:
      'Replace exact text in a file (unique old_string, or replace_all). Prefer for one surgical edit; use edit for new files or multi_edit for many files.',
    schema: strReplaceArgs
  },
  delete: {
    description: 'Delete a workspace file, or a directory when recursive=true.',
    schema: deleteArgs
  },
  todo_write: {
    description: "Record and update this run's visible task list.",
    schema: todoWriteArgs
  },
  browser_search: {
    description:
      'Search the web in the built-in agent browser using the configured search engine, then return a page snapshot.',
    schema: browserSearchArgs
  },
  browser_navigate: {
    description:
      'Open a URL in the built-in live browser window (JS rendered). Use browser_snapshot to read page content.',
    schema: browserNavigateArgs
  },
  browser_snapshot: {
    description:
      'Capture the current agent-browser page: interactive element refs (@eN), viewport, page text, and a UI screenshot. Call browser_navigate first; prefer @eN refs with browser_click / browser_type.',
    schema: browserSnapshotArgs
  },
  browser_click: {
    description:
      'Click an element in the agent browser by CSS selector or snapshot ref (@e12). Call browser_navigate first; use browser_snapshot to list refs.',
    schema: browserClickArgs
  },
  browser_type: {
    description:
      'Type text into the agent browser. Optionally focus a CSS selector or snapshot ref (@e12) first; can clear existing text and press Enter.',
    schema: browserTypeArgs
  },
  browser_scroll: {
    description:
      'Scroll the agent browser: pass a selector/@eN to scroll into view, or deltaX/deltaY to scroll the page.',
    schema: browserScrollArgs
  },
  browser_fill: {
    description:
      'Set the full value of an input/textarea/contenteditable (React-friendly). Prefer over browser_type when replacing a field. Uses @eN refs from browser_snapshot.',
    schema: browserFillArgs
  },
  browser_tabs: {
    description:
      'Manage agent-browser tabs: list, open (optional url), close, or select by tab_id.',
    schema: browserTabsArgs
  },
  browser_back: {
    description: 'Go back in the active (or specified) agent-browser tab history.',
    schema: browserBackArgs
  },
  browser_forward: {
    description: 'Go forward in the active (or specified) agent-browser tab history.',
    schema: browserForwardArgs
  },
  browser_wait_for_selector: {
    description:
      'Poll until a CSS selector or @eN ref is present and interactable, or timeout.',
    schema: browserWaitForSelectorArgs
  },
  browser_wait_for_url: {
    description: 'Poll until the page URL matches a substring or regex, or timeout.',
    schema: browserWaitForUrlArgs
  },
  browser_press_key: {
    description: 'Press a keyboard key (with optional modifiers) in the agent browser.',
    schema: browserPressKeyArgs
  },
  browser_select_option: {
    description: 'Select an option in a <select> by value or visible label.',
    schema: browserSelectOptionArgs
  },
  mcp_list_tools: {
    description:
      'List connected MCP tools (name, description, readOnlyHint). Marks tools omitted from this step catalog. Use request_mcp_tools to pin omitted tools for the next step.',
    schema: mcpListToolsArgs
  },
  request_mcp_tools: {
    description:
      'Pin MCP tool definitions into the next step provider catalog (budget-permitting). Effect applies on the following step, not mid-stream. Pass full mcp__server__tool names and/or a serverId.',
    schema: requestMcpToolsArgs
  },
  release_mcp_tools: {
    description:
      'Unpin MCP tool definitions so they drop from the sticky step catalog on the next model step (frees schema tokens). Re-pin with request_mcp_tools if needed. Pass full mcp__server__tool names and/or a serverId.',
    schema: releaseMcpToolsArgs
  },
  mcp_list_resources: {
    description:
      'List MCP resources (uri, name, description) from one server or all connected enabled servers.',
    schema: mcpListResourcesArgs
  },
  mcp_read_resource: {
    description: 'Read an MCP resource by server id and URI.',
    schema: mcpReadResourceArgs
  },
  mcp_list_prompts: {
    description:
      'List MCP prompts (name, description, arguments) from one server or all connected enabled servers.',
    schema: mcpListPromptsArgs
  },
  mcp_get_prompt: {
    description: 'Fetch a rendered MCP prompt by server id and name (optional arguments).',
    schema: mcpGetPromptArgs
  },
  ask_question: {
    description:
      'Pause and ask the user a typed question form in the transcript (single, multi, boolean, text; up to 8 questions). Blocks until they answer, skip, or a 15-minute timeout elapses; a skip/timeout returns guidance to proceed with a sensible default.',
    schema: askQuestionArgs
  },
  switch_mode: {
    description:
      'Switch this run between Ask (read-only), Plan (plan artifacts only), and Agent (full tools).',
    schema: switchModeArgs
  },
  terminal: {
    description:
      'Run a shell command with cwd at the workspace root (or working_directory under it). Output is capped. Use block_until_ms: 0 to start in the background (returns session_id: <uuid>); poll only with that UUID plus block_until_ms / pattern. Never invent session_id labels — omit session_id and pass command for a new shell.',
    schema: terminalArgs
  },
  memory_list: {
    description:
      'List long-term memory under .vyotiq/memory/: index excerpt, note names, whether state.md exists.',
    schema: memoryListArgs
  },
  memory_read: {
    description:
      'Read a memory file: index.md, state.md, or notes/<name>.md under .vyotiq/memory/.',
    schema: memoryReadArgs
  },
  memory_write: {
    description:
      'Create or update a memory file (index.md, state.md, or notes/<name>.md).',
    schema: memoryWriteArgs
  },
  Skill: {
    description:
      'Load an enabled Marketplace skill (SKILL.md) or plugin rule (`plugin-rule:…` id), or a relative file under a skill. Call when an Available skills or Plugin rules entry matches the task.',
    schema: skillArgs
  },
  git_status: {
    description: 'Structured git status for the workspace (branch, changed files, +/- counts).',
    schema: gitStatusArgs
  },
  git_diff: {
    description: 'Unified git diff for the workspace (optional path; optional staged).',
    schema: gitDiffArgs
  },
  git_commit: {
    description:
      'Create a git commit (optional push) staging only files this run changed plus optional explicit paths; unrelated dirty files stay uncommitted. Agent-only; requires approval when enabled.',
    schema: gitCommitArgs
  },
  diagnostics: {
    description:
      'Run project typecheck or lint and return structured diagnostics when parseable.',
    schema: diagnosticsArgs
  },
  generate_image: {
    description:
      'Generate an image via OpenAI, Gemini, xAI, OpenRouter, or an enabled custom OpenAI-compatible host and save it under the workspace. Chat provider can differ. Use preset=draft|final for quality defaults; set size/quality/resolution/output_format/n explicitly when needed. Ask/Plan: dry-run only. For edits use edit_image.',
    schema: generateImageArgs
  },
  edit_image: {
    description:
      'Edit or compose from workspace reference images (OpenAI / Gemini / xAI / OpenRouter / custom). Pass reference_paths (first = canvas). Omit path to overwrite the first reference; set path to write a new file. Optional mask_path (OpenAI / custom hosts that support edits). Ask/Plan: dry-run only.',
    schema: editImageArgs
  }
} as const

export type AgentToolName = keyof typeof TOOL_REGISTRY

export function toToolDefinitions(): ToolDefinition[] {
  return Object.entries(TOOL_REGISTRY).map(([name, { description, schema }]) => ({
    name,
    description,
    parameters: zodToJsonSchema(schema)
  }))
}

export const AGENT_TOOLS = toToolDefinitions()

type ZodDefLike = {
  typeName?: string
  innerType?: ZodTypeAny
  schema?: ZodTypeAny
  shape?: (() => Record<string, ZodTypeAny>) | Record<string, ZodTypeAny>
}

/** Peel Optional / Nullable / Default / Effects to reach an underlying ZodObject. */
function unwrapToObjectShape(schema: ZodTypeAny): Record<string, ZodTypeAny> | null {
  let s: ZodTypeAny = schema
  for (let i = 0; i < 12; i++) {
    const d = s._def as ZodDefLike
    if (d.typeName === 'ZodObject') {
      const shape = typeof d.shape === 'function' ? d.shape() : d.shape
      return shape ?? null
    }
    if (
      d.typeName === 'ZodOptional' ||
      d.typeName === 'ZodNullable' ||
      d.typeName === 'ZodDefault'
    ) {
      s = d.innerType as ZodTypeAny
      continue
    }
    if (d.typeName === 'ZodEffects') {
      s = d.schema as ZodTypeAny
      continue
    }
    break
  }
  return null
}

const READ_ARG_ALIASES: Record<string, string> = {
  name: 'path',
  maxChars: 'limit'
}

/** Models often send `path` instead of schema `include` (AppData a2c9: 4× TOOL_ARGS). */
const GREP_ARG_ALIASES: Record<string, string> = {
  path: 'include'
}

/**
 * Strip unknown keys (strict schemas reject them) and apply proven read/grep aliases
 * before validation. Does not invent required fields.
 */
function coerceToolArgsForValidate(name: string, parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed
  let obj = { ...(parsed as Record<string, unknown>) }

  if (name === 'read') {
    for (const [alias, canonical] of Object.entries(READ_ARG_ALIASES)) {
      if (obj[canonical] == null && obj[alias] != null) {
        obj[canonical] = obj[alias]
      }
    }
  } else if (name === 'grep') {
    for (const [alias, canonical] of Object.entries(GREP_ARG_ALIASES)) {
      if (obj[canonical] == null && obj[alias] != null) {
        obj[canonical] = obj[alias]
      }
    }
  }

  const entry = TOOL_REGISTRY[name as AgentToolName]
  if (!entry) return obj
  const shape = unwrapToObjectShape(entry.schema)
  if (!shape) return obj

  const allowed = new Set(Object.keys(shape))
  const stripped: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (!allowed.has(key)) continue
    if (name === 'ask_question' && key === 'questions' && Array.isArray(value)) {
      let itemKeys: Set<string> | null = null
      const qField = shape.questions
      if (qField) {
        let arr: ZodTypeAny = qField
        for (let i = 0; i < 6; i++) {
          const d = arr._def as ZodDefLike & { type?: ZodTypeAny }
          if (d.typeName === 'ZodOptional' || d.typeName === 'ZodNullable') {
            arr = d.innerType as ZodTypeAny
            continue
          }
          if (d.typeName === 'ZodArray' && d.type) {
            const elShape = unwrapToObjectShape(d.type)
            if (elShape) itemKeys = new Set(Object.keys(elShape))
            break
          }
          break
        }
      }
      stripped[key] = itemKeys
        ? value.map((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return item
            const row = item as Record<string, unknown>
            const out: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(row)) {
              if (itemKeys.has(k)) out[k] = v
            }
            return out
          })
        : value
      continue
    }
    stripped[key] = value
  }
  return stripped
}

function formatToolArgsError(name: string, detail: string): string {
  if (
    name === 'ask_question' &&
    (/\.type:/.test(detail) || /type must be|Invalid enum value.*type/i.test(detail))
  ) {
    return `${detail}. Each questions[].type must be one of: single, multi, boolean, text`
  }
  if (name === 'ask_question' && /Required/.test(detail) && /\.type/.test(detail)) {
    return `${detail}. Each questions[].type must be one of: single, multi, boolean, text`
  }
  return detail || 'Invalid tool arguments'
}

export function validateToolArgs(
  name: string,
  rawJson: string
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const entry = TOOL_REGISTRY[name as AgentToolName]
  if (!entry) return { ok: false, error: `Unknown tool: ${name}` }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson || '{}')
  } catch {
    return { ok: false, error: 'Failed to parse tool arguments JSON' }
  }

  const coerced = coerceToolArgsForValidate(name, parsed)
  const result = entry.schema.safeParse(coerced)
  if (!result.success) {
    const detail = result.error.errors
      .map((e) => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .join('; ')
    return { ok: false, error: formatToolArgsError(name, detail) }
  }

  return { ok: true, data: result.data as Record<string, unknown> }
}
