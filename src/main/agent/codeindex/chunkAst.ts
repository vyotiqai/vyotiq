import { existsSync } from 'fs'
import { createRequire } from 'module'
import { dirname, extname, join } from 'path'
import type { ChunkKind, CodeChunk } from './types'
import { MAX_CHUNK_CHARS } from './types'
import { appendModuleContextChunks, chunkSource as chunkSourceFallback, dropParentSpansCoveredByChildren } from './chunk'

type GrammarId = 'typescript' | 'tsx' | 'javascript' | 'python' | 'go' | 'rust' | 'java' | 'csharp'

const EXT_GRAMMAR: Record<string, GrammarId> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'csharp'
}

const GRAMMAR_FILE: Record<GrammarId, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  csharp: 'tree-sitter-c_sharp.wasm'
}

const TS_LIKE_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'method_definition',
  'abstract_class_declaration'
])

const PY_TYPES = new Set(['function_definition', 'class_definition'])
const GO_TYPES = new Set(['function_declaration', 'method_declaration', 'type_declaration'])
const RUST_TYPES = new Set([
  'function_item',
  'impl_item',
  'struct_item',
  'enum_item',
  'mod_item',
  'trait_item'
])
const JAVA_TYPES = new Set([
  'method_declaration',
  'constructor_declaration',
  'class_declaration',
  'interface_declaration',
  'enum_declaration'
])
const CSHARP_TYPES = new Set([
  'method_declaration',
  'constructor_declaration',
  'class_declaration',
  'interface_declaration',
  'struct_declaration',
  'record_declaration'
])

type TsTree = {
  rootNode: TsNode
  delete(): void
}

type TsParser = {
  setLanguage(lang: unknown): void
  parse(input: string): TsTree
  delete(): void
}

type TsNode = {
  type: string
  startPosition: { row: number; column: number }
  endPosition: { row: number; column: number }
  startIndex: number
  endIndex: number
  text: string
  childCount: number
  child(i: number): TsNode | null
  namedChildren: TsNode[]
  children: TsNode[]
}

let initPromise: Promise<boolean> | null = null
const languageCache = new Map<GrammarId, unknown>()
const parserCache = new Map<GrammarId, TsParser>()
type ParserStatic = {
  new (): TsParser
  init(opts?: { locateFile?: (scriptName: string) => string }): Promise<void>
}
type LanguageStatic = {
  load(path: string): Promise<unknown>
}
let ParserCtor: ParserStatic | null = null
let LanguageLoad: LanguageStatic | null = null

/**
 * Electron-packaged extraResources land at `resourcesPath/codeindex/wasm`
 * (see electron-builder.yml). Unpackaged / vitest use app path or cwd.
 * node_modules paths are last-resort (dev); asar WASM load is unreliable.
 */
function moduleRequire(): NodeRequire {
  try {
    return createRequire(import.meta.url)
  } catch {
    return createRequire(join(process.cwd(), 'package.json'))
  }
}

/** Injected by embed utility (main resolves electron.app / resourcesPath). */
let wasmDirOverride: string | null = null

/** Prefer this directory when resolving tree-sitter WASM (utilityProcess path). */
export function setCodeindexWasmDirOverride(dir: string | null | undefined): void {
  const trimmed = dir?.trim()
  wasmDirOverride = trimmed ? trimmed : null
}

function wasmCandidateDirs(): string[] {
  const dirs: string[] = []
  const push = (dir: string | null | undefined): void => {
    if (dir && !dirs.includes(dir)) dirs.push(dir)
  }

  push(wasmDirOverride)

  // Mirror harness/marketplace: packaged → resourcesPath; else → app.getAppPath()/resources
  try {
    const electron = moduleRequire()('electron') as unknown
    // Outside Electron, `require('electron')` is the binary path string.
    if (electron && typeof electron === 'object' && electron !== null && 'app' in electron) {
      const app = (electron as { app?: { isPackaged?: boolean; getAppPath?: () => string } }).app
      if (app?.getAppPath) {
        if (app.isPackaged && typeof process.resourcesPath === 'string' && process.resourcesPath) {
          push(join(process.resourcesPath, 'codeindex', 'wasm'))
        } else {
          push(join(app.getAppPath(), 'resources', 'codeindex', 'wasm'))
        }
      }
    }
  } catch {
    /* optional */
  }

  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    push(join(process.resourcesPath, 'codeindex', 'wasm'))
  }
  push(join(process.cwd(), 'resources', 'codeindex', 'wasm'))

  try {
    const req = moduleRequire()
    try {
      const wtsMain = req.resolve('web-tree-sitter')
      push(dirname(wtsMain))
    } catch {
      /* optional */
    }
    try {
      const wasmsPkg = dirname(req.resolve('tree-sitter-wasms/README.md'))
      push(join(wasmsPkg, 'out'))
    } catch {
      /* optional */
    }
  } catch {
    /* optional */
  }
  return dirs
}

/** Test/helper: resolved search roots for grammar + core WASM. */
export function codeindexWasmCandidateDirs(): string[] {
  return wasmCandidateDirs()
}

function findWasmFile(fileName: string): string | null {
  for (const dir of wasmCandidateDirs()) {
    const full = join(dir, fileName)
    if (existsSync(full)) return full
  }
  return null
}

/** Test/helper: first existing path for a WASM asset (packaged resourcesPath wins when set). */
export function resolveCodeindexWasmFile(fileName: string): string | null {
  return findWasmFile(fileName)
}

async function ensureParserReady(): Promise<boolean> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    try {
      const mod = await import('web-tree-sitter')
      ParserCtor = mod.Parser as unknown as ParserStatic
      LanguageLoad = mod.Language as unknown as LanguageStatic
      if (!ParserCtor || !LanguageLoad) return false
      const coreWasm = findWasmFile('web-tree-sitter.wasm')
      if (!coreWasm) return false
      await ParserCtor.init({
        locateFile: (scriptName: string) => {
          if (scriptName.endsWith('.wasm')) {
            return findWasmFile(scriptName) ?? coreWasm
          }
          return scriptName
        }
      })
      return true
    } catch {
      return false
    }
  })()
  const ok = await initPromise
  // WASM dir can be injected after the first miss (utilityProcess); retry later.
  if (!ok) initPromise = null
  return ok
}

async function parserFor(grammar: GrammarId, lang: unknown): Promise<TsParser | null> {
  if (!ParserCtor) return null
  const cached = parserCache.get(grammar)
  if (cached) return cached
  const parser = new ParserCtor()
  parser.setLanguage(lang)
  parserCache.set(grammar, parser)
  return parser
}

/** Free reused tree-sitter parsers (utility dispose / tests). */
export function disposeChunkParsers(): void {
  for (const parser of parserCache.values()) {
    try {
      parser.delete()
    } catch {
      /* ignore */
    }
  }
  parserCache.clear()
}

async function loadLanguage(id: GrammarId): Promise<unknown | null> {
  if (languageCache.has(id)) return languageCache.get(id)!
  if (!(await ensureParserReady()) || !LanguageLoad) return null
  const path = findWasmFile(GRAMMAR_FILE[id])
  if (!path) return null
  try {
    const lang = await LanguageLoad.load(path)
    languageCache.set(id, lang)
    return lang
  } catch {
    return null
  }
}

function toLines(source: string): string[] {
  return source.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

function sliceLines(lines: string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join('\n')
}

function contextualize(
  path: string,
  kind: ChunkKind,
  name: string,
  parentName: string | undefined,
  text: string
): string {
  const header = [
    `file: ${path}`,
    parentName ? `parent: ${parentName}` : null,
    `kind: ${kind}`,
    `name: ${name}`
  ]
    .filter(Boolean)
    .join('\n')
  return `${header}\n\n${text}`
}

function makeChunk(
  path: string,
  lines: string[],
  startLine: number,
  endLine: number,
  kind: ChunkKind,
  name: string,
  parentName?: string
): CodeChunk {
  const text = sliceLines(lines, startLine, endLine)
  return {
    path,
    startLine,
    endLine,
    kind,
    name,
    parentName,
    text,
    contextualizedText: contextualize(path, kind, name, parentName, text)
  }
}

function splitOversized(
  path: string,
  lines: string[],
  startLine: number,
  endLine: number,
  kind: ChunkKind,
  name: string,
  parentName?: string
): CodeChunk[] {
  const text = sliceLines(lines, startLine, endLine)
  if (text.length <= MAX_CHUNK_CHARS) {
    return [makeChunk(path, lines, startLine, endLine, kind, name, parentName)]
  }
  const out: CodeChunk[] = []
  let start = startLine
  while (start <= endLine) {
    let end = start
    let size = 0
    while (end <= endLine) {
      const lineLen = (lines[end - 1]?.length ?? 0) + 1
      if (size > 0 && size + lineLen > MAX_CHUNK_CHARS) break
      size += lineLen
      end++
    }
    const last = Math.max(start, end - 1)
    out.push(
      makeChunk(
        path,
        lines,
        start,
        last,
        kind,
        `${name}#${out.length + 1}`,
        parentName ?? name
      )
    )
    start = last + 1
  }
  return out
}

function nodeName(node: TsNode, source: string): string {
  for (const child of node.namedChildren ?? node.children ?? []) {
    if (
      child.type === 'identifier' ||
      child.type === 'property_identifier' ||
      child.type === 'type_identifier'
    ) {
      return source.slice(child.startIndex, child.endIndex) || 'anon'
    }
  }
  // Python: name is often a direct identifier child
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)
    if (c && (c.type === 'identifier' || c.type === 'type_identifier')) {
      return source.slice(c.startIndex, c.endIndex) || 'anon'
    }
  }
  return 'anon'
}

function kindForType(type: string, parentClass: string | undefined): ChunkKind {
  if (type.includes('class') || type === 'class_definition') return 'class'
  if (type.includes('method') || (parentClass && type.includes('function'))) {
    return parentClass ? 'method' : 'function'
  }
  if (type.includes('function') || type === 'function_definition') return 'function'
  if (type.includes('interface') || type.includes('type_alias') || type.includes('enum')) {
    return 'block'
  }
  return 'block'
}

type Span = {
  startLine: number
  endLine: number
  kind: ChunkKind
  name: string
  parentName?: string
}

function collectSpans(root: TsNode, source: string, grammar: GrammarId): Span[] {
  const spans: Span[] = []
  const interesting =
    grammar === 'python'
      ? PY_TYPES
      : grammar === 'go'
        ? GO_TYPES
        : grammar === 'rust'
          ? RUST_TYPES
          : grammar === 'java'
            ? JAVA_TYPES
            : grammar === 'csharp'
              ? CSHARP_TYPES
              : TS_LIKE_TYPES

  const walk = (node: TsNode, classStack: string[], fnDepth: number): void => {
    // Module-level const/export arrows only. Nested closures stay inside the parent chunk.
    if (
      grammar !== 'python' &&
      fnDepth === 0 &&
      (node.type === 'lexical_declaration' ||
        node.type === 'variable_declaration' ||
        node.type === 'export_statement')
    ) {
      const arrow = findDescendant(node, (n) => n.type === 'arrow_function')
      const fnExpr = findDescendant(node, (n) => n.type === 'function_expression' || n.type === 'generator_function')
      const named = findDescendant(
        node,
        (n) => n.type === 'function_declaration' || n.type === 'class_declaration'
      )
      if (named && interesting.has(named.type)) {
        // handled when we visit the named node
      } else if (arrow || fnExpr) {
        const name =
          findDescendant(node, (n) => n.type === 'identifier' || n.type === 'property_identifier')
            ?.text ?? nodeName(node, source)
        spans.push({
          startLine: node.startPosition.row + 1,
          endLine: Math.max(node.startPosition.row + 1, node.endPosition.row + 1),
          kind: 'function',
          name: name || 'anon',
          parentName: classStack[classStack.length - 1]
        })
        for (let i = 0; i < node.childCount; i++) {
          const c = node.child(i)
          if (c) walk(c, classStack, fnDepth + 1)
        }
        return
      }
    }

    if (interesting.has(node.type)) {
      const parentClass = classStack[classStack.length - 1]
      const kind = kindForType(node.type, parentClass)
      const name = nodeName(node, source)
      const nestedFn = fnDepth > 0 && kind !== 'class' && kind !== 'method'
      if (!nestedFn) {
        spans.push({
          startLine: node.startPosition.row + 1,
          endLine: Math.max(node.startPosition.row + 1, node.endPosition.row + 1),
          kind: kind === 'function' && parentClass ? 'method' : kind,
          name,
          parentName: kind === 'class' ? undefined : parentClass
        })
      }
      const nextStack = kind === 'class' ? [...classStack, name] : classStack
      const nextFnDepth = kind === 'class' ? fnDepth : fnDepth + 1
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i)
        if (c) walk(c, nextStack, nextFnDepth)
      }
      return
    }

    // Python decorated_definition wraps function/class
    if (grammar === 'python' && node.type === 'decorated_definition') {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i)
        if (c) walk(c, classStack, fnDepth)
      }
      return
    }

    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i)
      if (c) walk(c, classStack, fnDepth)
    }
  }

  walk(root, [], 0)
  return spans
}

function findDescendant(node: TsNode, pred: (n: TsNode) => boolean): TsNode | null {
  if (pred(node)) return node
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)
    if (!c) continue
    const found = findDescendant(c, pred)
    if (found) return found
  }
  return null
}

function spansToChunks(path: string, source: string, spans: Span[]): CodeChunk[] {
  const lines = toLines(source)
  const sorted = dropParentSpansCoveredByChildren(
    [...spans].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine)
  )
  const covered = new Set<number>()
  const chunks: CodeChunk[] = []
  for (const span of sorted) {
    for (let ln = span.startLine; ln <= span.endLine; ln++) covered.add(ln)
    chunks.push(
      ...splitOversized(
        path,
        lines,
        span.startLine,
        span.endLine,
        span.kind,
        span.name,
        span.parentName
      )
    )
  }

  appendModuleContextChunks(chunks, path, lines, covered)

  if (!chunks.length && source.trim()) {
    chunks.push(
      makeChunk(path, lines, 1, Math.max(1, lines.length), 'module', path.split('/').pop() ?? 'file')
    )
  }
  return chunks.sort((a, b) => a.startLine - b.startLine)
}

/**
 * AST-aware chunking via web-tree-sitter WASM for TS/JS/Py.
 * Falls back to brace/indent heuristics on init/parse failure or unsupported ext.
 */
export async function chunkSourceAst(path: string, source: string): Promise<CodeChunk[]> {
  const ext = extname(path).toLowerCase()
  const grammar = EXT_GRAMMAR[ext]
  if (!grammar) return chunkSourceFallback(path, source)

  const lang = await loadLanguage(grammar)
  if (!lang || !ParserCtor) return chunkSourceFallback(path, source)

  const parser = await parserFor(grammar, lang)
  if (!parser) return chunkSourceFallback(path, source)

  let tree: TsTree | null = null
  try {
    tree = parser.parse(source)
    const spans = collectSpans(tree.rootNode, source, grammar)
    if (!spans.length) return chunkSourceFallback(path, source)
    return spansToChunks(path, source, spans)
  } catch {
    return chunkSourceFallback(path, source)
  } finally {
    try {
      tree?.delete()
    } catch {
      /* ignore */
    }
  }
}

/** Test helper: whether WASM grammars loaded. */
export async function treeSitterReady(): Promise<boolean> {
  return ensureParserReady()
}
