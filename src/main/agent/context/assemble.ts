import type { ChatMessage, ModelInfo } from '../../../shared/ipc'
import { contentToText, flattenFileParts } from '../../../shared/ipc'
import type { LlmProvider } from '../providers/types'
import { anthropicNativeOptions } from './anthropicContext'
import { crossesCompactionTrigger } from '../../../shared/domain/contextBudget'
import { allocateBudget, compactionTriggerTokens, contentWindow } from './budget'
import { compactMessages, preserveRecentMessagesAsync } from './compact'
import {
  blendInputTokens,
  estimateMessagesTokensAsync,
  estimateTextTokens,
  estimateTextTokensAsync
} from './estimate'
import { readMemoryIndexAsync, readMemoryStateAsync } from './memory'
import { trimHistoryToBudgetAsync } from './historyTrim'
import { trimToolResults } from './toolTrim'
import { stubPastSkillInvocationsInMessages } from '../../../shared/slashCommands'
import {
  KEEP_RECENT_TURNS,
  KEEP_LAST_TOOL_RESULTS,
  isTrimWatermarkCompaction,
  type AssembleInput,
  type AssembleResult,
  type CompactionRecord,
  type ContextLayerBreakdown
} from './types'
import {
  extractAskQuestionDecisions,
  loopHintForRetainedDecisions
} from './retainedDecisions'
import { stripUnsupportedModalitiesFromMessages, wireCapsFromModel } from './stripImages'
import { buildWorkspaceRulesSection } from './rules'
import { buildWorkspaceSnapshotAsync } from './workspaceSnapshot'
import { logger } from '../../../shared/logger'
import { perfLog, perfNow } from './perfDebug'
import {
  combineLoopHints,
  loopHintForCompactionFailure,
  loopHintForCompactionPaybackSkip
} from '../loopPolicy'
import {
  residualFloorAfterFold,
  shouldInvokeCompactionLlm
} from './compactionPayback'

const COMPACTION_MIN_MESSAGES = 4
const COMPACTION_MIN_TOKENS = 2000

/** In-process cache for the stable instruction prefix only (not the volatile tail). */
type SystemCacheEntry = { fingerprint: string; stable: string }
let systemPromptCache: SystemCacheEntry | null = null

/** @internal — clear stable system-prefix cache (tests). */
export function clearSystemPromptCache(): void {
  systemPromptCache = null
}

/**
 * Fingerprint of durable instruction layers only. Volatile data (clock, snapshot,
 * memory, loop hints, compaction summary) must not appear here or the cache
 * never hits across steps.
 */
function stableSystemFingerprint(parts: {
  harness: string
  rules: string
  skillsSection: string
  pluginRulesSection: string
  contract: string
  plan: string
  modeSection?: string
  systemBudget: number
}): string {
  return [
    parts.harness,
    parts.rules,
    parts.skillsSection,
    parts.pluginRulesSection,
    parts.contract,
    parts.plan,
    parts.modeSection ?? '',
    String(parts.systemBudget)
  ].join('\0')
}

function capText(text: string, maxTokens: number): string {
  const maxChars = Math.max(200, maxTokens * 4)
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '\n…'
}

/**
 * Token-accurate clamp on top of the char heuristic: dense text (CJK, code)
 * tokenizes well above 4 chars/token, so a char-only cap can overshoot the
 * budget and let sections sum past the system layer.
 */
function capToTokenBudget(text: string, maxTokens: number, model: ModelInfo): string {
  let out = capText(text, maxTokens)
  while (out.length > 200 && estimateTextTokens(out, model) > maxTokens) {
    out = out.slice(0, Math.floor(out.length * 0.8))
  }
  return out
}

/**
 * Tally of wire-relevant content. Catches in-place trims (tool stubs, thinking
 * drops) that leave message count unchanged.
 */
function wireContentChars(messages: ChatMessage[]): number {
  let n = 0
  for (const m of messages) {
    n += contentToText(m.content).length
    if (m.thinking) n += m.thinking.length
    if (m.reasoningState) n += 1
  }
  return n
}

/**
 * Lower priority = drop first when capping. Core instruction sections kept longest.
 * All core instruction headings are >= 95 so capHarness never discards them.
 */
function harnessSectionPriority(heading: string): number {
  const h = heading.toLowerCase()
  if (h.includes('role')) return 100
  if (h.includes('tool')) return 99
  if (h.includes('constraints')) return 98
  if (h.includes('output format')) return 97
  if (h.includes('capabilities')) return 96
  if (h.includes('work style') || h.includes('workstyle')) return 95
  if (h.includes('memory')) return 50
  if (h.includes('context')) return 40
  return 20
}

/**
 * Cap harness text by dropping lowest-priority ## sections first,
 * then truncating what remains.
 */
function capHarness(text: string, maxTokens: number): string {
  const maxChars = Math.max(200, maxTokens * 4)
  if (text.length <= maxChars) return text

  const chunks = text.split(/(?=^##\s+)/m).map((c) => c.trimEnd()).filter(Boolean)
  if (chunks.length <= 1) return capText(text, maxTokens)

  type Sec = { text: string; priority: number; keep: boolean }
  const sections: Sec[] = chunks.map((chunk) => {
    const m = /^##\s+(.+)$/m.exec(chunk)
    const priority = m ? harnessSectionPriority(m[1].trim()) : 95
    return { text: chunk, priority, keep: true }
  })

  const joined = (): string =>
    sections
      .filter((s) => s.keep)
      .map((s) => s.text)
      .join('\n\n')
      .trimEnd()

  let out = joined()
  if (out.length <= maxChars) return out

  const dropOrder = [...sections.keys()].sort(
    (a, b) => sections[a].priority - sections[b].priority
  )
  for (const idx of dropOrder) {
    if (sections[idx].priority >= 95) continue
    sections[idx].keep = false
    out = joined()
    if (out.length <= maxChars) return out
  }

  return capText(out || text, maxTokens)
}

function buildStableSystem(parts: {
  harness: string
  rules: string
  skillsSection?: string
  pluginRulesSection?: string
  contract?: string
  plan?: string
  modeSection?: string
  budgets: ReturnType<typeof allocateBudget>
  model: ModelInfo
}): string {
  const fingerprint = stableSystemFingerprint({
    harness: parts.harness,
    rules: parts.rules,
    skillsSection: parts.skillsSection ?? '',
    pluginRulesSection: parts.pluginRulesSection ?? '',
    contract: parts.contract ?? '',
    plan: parts.plan ?? '',
    modeSection: parts.modeSection,
    systemBudget: parts.budgets.system
  })
  if (systemPromptCache?.fingerprint === fingerprint) {
    return systemPromptCache.stable
  }

  const sections: string[] = []
  let systemTokensLeft = parts.budgets.system
  function capWithinSystem(
    text: string,
    requested: number,
    capFn: (text: string, maxTokens: number) => string = capText
  ): string | null {
    if (systemTokensLeft < 50) return null
    const allowed = Math.min(requested, systemTokensLeft)
    const capped = capToTokenBudget(capFn(text, allowed), allowed, parts.model)
    const used = estimateTextTokens(capped, parts.model)
    systemTokensLeft -= used
    return capped
  }

  const harness = capWithinSystem(
    parts.harness,
    Math.floor(parts.budgets.system * 0.75),
    capHarness
  )
  if (harness) sections.push(harness)

  if (parts.modeSection?.trim()) {
    const mode = capWithinSystem(
      parts.modeSection.trim(),
      Math.max(400, Math.floor(parts.budgets.system * 0.35))
    )
    if (mode) sections.push(mode)
  }

  // Run directives come before rules/skills so they are not buried.
  if (parts.contract?.trim()) {
    // Strip an existing `# Run contract` or `## Run contract` heading so we
    // don't duplicate the wrapper we prepend.
    const contractBody = parts.contract.trim().replace(/^#+\s*Run contract\s*(?:\r?\n)*/i, '')
    const contract = capWithinSystem(
      `## Run contract\n${contractBody}`,
      Math.floor(parts.budgets.system * 0.4)
    )
    if (contract) sections.push(contract)
  }
  if (parts.plan?.trim()) {
    const planBody = parts.plan.trim().replace(/^#+\s*Plan\s*(?:\r?\n)*/i, '')
    const plan = capWithinSystem(`## Plan\n${planBody}`, Math.floor(parts.budgets.system * 0.4))
    if (plan) sections.push(plan)
  }

  // Workspace conventions and add-on rules (metadata for skills / plugin rules).
  if (parts.skillsSection?.trim()) {
    const skills = capWithinSystem(parts.skillsSection.trim(), Math.floor(parts.budgets.system * 0.35))
    if (skills) sections.push(skills)
  }
  if (parts.pluginRulesSection?.trim()) {
    const plugins = capWithinSystem(parts.pluginRulesSection.trim(), Math.floor(parts.budgets.system * 0.25))
    if (plugins) sections.push(plugins)
  }
  if (parts.rules.trim()) {
    const rules = capWithinSystem(parts.rules.trim(), Math.floor(parts.budgets.system * 0.5))
    if (rules) sections.push(rules)
  }

  const stable = sections.join('\n\n')
  systemPromptCache = { fingerprint, stable }
  return stable
}

/** Per-step data layers: clock, snapshot, notices, memory, compaction summary. */
function buildVolatileSystem(parts: {
  workspace: string
  memoryIndex: string
  memoryState: string
  sessionEnv?: string
  compaction?: CompactionRecord | null
  budgets: ReturnType<typeof allocateBudget>
  loopHint?: string
}): string {
  const sections: string[] = []
  const mw = Math.floor(parts.budgets.memoryWorkspace / 3)
  const envCap = Math.max(200, Math.floor(parts.budgets.system * 0.15))

  // Session env and workspace snapshot are data, not instructions.
  if (parts.sessionEnv?.trim()) {
    sections.push(capText(parts.sessionEnv.trim(), envCap))
  }
  if (parts.workspace.trim()) {
    sections.push(capText(parts.workspace, mw))
  }
  if (parts.loopHint?.trim()) {
    sections.push(`## Run notice\n${capText(parts.loopHint.trim(), Math.floor(mw * 0.5))}`)
  }
  if (parts.memoryIndex.trim()) {
    sections.push(`## Memory index\n${capText(parts.memoryIndex, mw)}`)
  }
  if (parts.memoryState.trim()) {
    sections.push(`## Memory state\n${capText(parts.memoryState, mw)}`)
  }
  if (parts.compaction?.summary && !isTrimWatermarkCompaction(parts.compaction)) {
    sections.push(
      [
        '## Prior session summary',
        // Summaries accumulate across compact, so this needs a cap like every
        // other section or it can crowd out the harness it sits beside.
        capText(parts.compaction.summary, mw)
      ].join('\n')
    )
  }
  return sections.join('\n\n')
}

type SystemZones = { stable: string; volatile: string; system: string }

/**
 * Two-zone system string: stable instruction prefix + volatile data tail.
 * Combined `system` is a fallback for providers that ignore zones; prefer
 * `systemStable` / `systemVolatile` (OpenAI, Gemini, Anthropic cache prefixes).
 */
function buildSystemZones(parts: {
  harness: string
  workspace: string
  rules: string
  skillsSection?: string
  pluginRulesSection?: string
  memoryIndex: string
  memoryState: string
  contract?: string
  plan?: string
  modeSection?: string
  sessionEnv?: string
  compaction?: CompactionRecord | null
  budgets: ReturnType<typeof allocateBudget>
  loopHint?: string
  model: ModelInfo
}): SystemZones {
  const stable = buildStableSystem({
    harness: parts.harness,
    rules: parts.rules,
    skillsSection: parts.skillsSection,
    pluginRulesSection: parts.pluginRulesSection,
    contract: parts.contract,
    plan: parts.plan,
    modeSection: parts.modeSection,
    budgets: parts.budgets,
    model: parts.model
  })
  const volatile = buildVolatileSystem({
    workspace: parts.workspace,
    memoryIndex: parts.memoryIndex,
    memoryState: parts.memoryState,
    sessionEnv: parts.sessionEnv,
    compaction: parts.compaction,
    budgets: parts.budgets,
    loopHint: parts.loopHint
  })
  const system = !volatile ? stable : !stable ? volatile : `${stable}\n\n${volatile}`
  return { stable, volatile, system }
}

async function computeLayers(
  system: string,
  messages: ChatMessage[],
  toolsJsonEstimate: number,
  model: ModelInfo,
  budgets: ReturnType<typeof allocateBudget>
): Promise<ContextLayerBreakdown> {
  const [systemTokens, history] = await Promise.all([
    estimateTextTokensAsync(system, model),
    estimateMessagesTokensAsync(messages, model)
  ])
  return {
    system: systemTokens,
    history,
    tools: toolsJsonEstimate,
    buffer: budgets.buffer
  }
}

function totalFromLayers(layers: ContextLayerBreakdown): number {
  return layers.system + layers.history + layers.tools
}

/** Overflow last-resort: drop UI thinking and provider reasoning replay from the wire set. */
export function stripThinkingForCompaction(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (!m.thinking && !m.reasoningState) return m
    // Drop UI thinking *and* provider replay state (what actually rides on the wire
    // for Anthropic / OpenAI-compat / Responses).
    const { thinking: _thinking, reasoningState: _reasoningState, ...rest } = m
    return rest
  })
}

async function shouldCompactHistory(
  toSummarize: ChatMessage[],
  model: ModelInfo
): Promise<boolean> {
  if (toSummarize.length > COMPACTION_MIN_MESSAGES) return true
  return (await estimateMessagesTokensAsync(toSummarize, model)) >= COMPACTION_MIN_TOKENS
}

function resolveUsedTokens(
  estimated: number,
  lastUsage: AssembleInput['lastUsage'],
  trigger: number
): number {
  const providerHint = lastUsage?.inputTokens
  // Prefer local estimate only when the provider hint looks inflated *and*
  // is still below the compaction trigger. If the provider already reports
  // at/over trigger, trust it so we do not defer compaction.
  if (
    providerHint !== undefined &&
    providerHint > estimated &&
    estimated < trigger * 0.5 &&
    providerHint < trigger
  ) {
    return estimated
  }
  return blendInputTokens(estimated, lastUsage)
}

export async function assembleContext(
  input: AssembleInput & {
    providerId: import('../../../shared/ipc').ProviderId
    provider: LlmProvider
    apiKey?: string | null
    baseUrl?: string
    signal: AbortSignal
  }
): Promise<AssembleResult> {
  const assembleStarted = perfNow()
  const budgets = allocateBudget(input.model)
  const keepRecent = input.keepRecentTurns ?? KEEP_RECENT_TURNS
  const triggerRatio = input.compactionTriggerRatio ?? 0.7
  const window = contentWindow(input.model)

  const [workspace, rules] = await Promise.all([
    buildWorkspaceSnapshotAsync(input.workspacePath, input.goal),
    buildWorkspaceRulesSection(input.workspacePath)
  ])
  const [memoryIndex, memoryState] = input.workspacePath
    ? await Promise.all([
        readMemoryIndexAsync(input.workspacePath),
        readMemoryStateAsync(input.workspacePath)
      ])
    : ['', '']

  // Text attachments flatten to text; audio/native files stay until caps apply.
  // Tool bodies must NOT be stubbed here — only the budget-pressure paths below
  // trim them. Unconditional stubbing amnesia-looped the model into re-reading
  // cleared files every step (run 2791fd89: 168 reads / 1.18M billed tokens).
  let messages = input.messages.map((message) =>
    typeof message.content === 'string'
      ? message
      : { ...message, content: flattenFileParts(message.content) }
  )
  // Drop full skill bodies from past turns (keep open skill turn intact).
  messages = stubPastSkillInvocationsInMessages(messages).messages
  messages = stripUnsupportedModalitiesFromMessages(messages, wireCapsFromModel(input.model))
  let compaction = input.priorCompaction ?? null
  let contextShrunk = false

  const estimateStarted = perfNow()
  const systemParts = {
    harness: input.harness,
    workspace,
    rules,
    skillsSection: input.skillsSection,
    pluginRulesSection: input.pluginRulesSection,
    memoryIndex,
    memoryState,
    contract: input.contract,
    plan: input.plan,
    modeSection: input.modeSection,
    sessionEnv: input.sessionEnv,
    budgets,
    loopHint: input.loopHint,
    model: input.model
  }

  const systemDraftZones = buildSystemZones({
    ...systemParts,
    compaction
  })

  let layers = await computeLayers(
    systemDraftZones.system,
    messages,
    input.toolsJsonEstimate,
    input.model,
    budgets
  )
  let estimated = totalFromLayers(layers)
  perfLog('estimateMessagesTokens', estimateStarted, {
    messages: messages.length,
    estimated
  })

  const trigger = compactionTriggerTokens(input.model, triggerRatio)
  let used = resolveUsedTokens(estimated, input.lastUsage, trigger)

  if (crossesCompactionTrigger(used, estimated, trigger)) {
    // Cheap trim first — clear ephemeral tool bodies only (durable tools excluded).
    const beforeCheap = messages.length
    // Stub-only trims keep message count; compare wire content so the loop's
    // adoption gate still picks them up (otherwise compaction re-fires every step).
    const beforeCheapChars = wireContentChars(messages)
    messages = trimToolResults(messages, KEEP_LAST_TOOL_RESULTS)
    messages = await trimHistoryToBudgetAsync(
      messages,
      Math.max(1500, trigger - layers.system - (input.toolsJsonEstimate || 0)),
      input.model
    )
    if (messages.length < beforeCheap || wireContentChars(messages) !== beforeCheapChars) {
      contextShrunk = true
    }
    layers = await computeLayers(
      buildSystemZones({ ...systemParts, compaction }).system,
      messages,
      input.toolsJsonEstimate,
      input.model,
      budgets
    )
    estimated = totalFromLayers(layers)
    used = contextShrunk ? estimated : resolveUsedTokens(estimated, input.lastUsage, trigger)

    if (crossesCompactionTrigger(used, estimated, trigger)) {
      const keptForBoundary = await preserveRecentMessagesAsync(
        messages,
        keepRecent,
        budgets.history,
        input.model
      )
      const toSummarize = messages.slice(0, Math.max(0, messages.length - keptForBoundary.length))
      if (await shouldCompactHistory(toSummarize, input.model)) {
        const foldTokens = await estimateMessagesTokensAsync(toSummarize, input.model)
        const keptTokens = await estimateMessagesTokensAsync(keptForBoundary, input.model)
        const payback = shouldInvokeCompactionLlm({
          foldTokens,
          residualFloor: residualFloorAfterFold({
            keptTokens,
            systemTokens: layers.system,
            toolsTokens: input.toolsJsonEstimate || 0
          }),
          trigger,
          hasPriorLlmSummary: Boolean(
            compaction?.summary && !isTrimWatermarkCompaction(compaction)
          )
        })
        if (!payback.invokeLlm) {
          // Preserve ask_question answers before dropping the fold prefix.
          const retained = extractAskQuestionDecisions(toSummarize)
          messages = keptForBoundary
          contextShrunk = true
          systemParts.loopHint = combineLoopHints(
            systemParts.loopHint,
            loopHintForCompactionPaybackSkip(payback.reason),
            loopHintForRetainedDecisions(retained)
          )
          logger.info('Compaction LLM skipped (payback gate)', {
            scope: 'agent',
            code: 'TOKEN_COST',
            reason: payback.reason,
            foldTokens,
            trigger,
            estimated,
            retainedDecisions: retained.length
          })
        } else {
          const record = await compactMessages({
            provider: input.provider,
            model: input.model.id,
            apiKey: input.apiKey,
            baseUrl: input.baseUrl,
            signal: input.signal,
            messages: stripThinkingForCompaction(toSummarize),
            supportsStructuredOutput: input.model.supportsStructuredOutput,
            contextWindow: window,
            priorSummary: isTrimWatermarkCompaction(compaction)
              ? undefined
              : compaction?.summary
          })
          if (record) {
            messages = keptForBoundary
            compaction = record
            contextShrunk = true
          } else {
            // Summarize failed — keep recent turns and shrink so the next step does
            // not re-invoke the same compaction LLM call. The loop persists a trim
            // watermark from contextShrunk + dropped count.
            messages = keptForBoundary
            contextShrunk = true
            systemParts.loopHint = combineLoopHints(
              systemParts.loopHint,
              loopHintForCompactionFailure()
            )
          }
        }
      }
    }
  }
  messages = await trimHistoryToBudgetAsync(messages, budgets.history, input.model)

  let zones = buildSystemZones({
    ...systemParts,
    compaction
  })

  layers = await computeLayers(zones.system, messages, input.toolsJsonEstimate, input.model, budgets)
  estimated = totalFromLayers(layers)

  if (estimated > window) {
    const priorLen = messages.length
    messages = await trimHistoryToBudgetAsync(messages, Math.floor(budgets.history * 0.5), input.model)
    if (messages.length < priorLen) contextShrunk = true
    zones = buildSystemZones({
      ...systemParts,
      compaction
    })
    layers = await computeLayers(zones.system, messages, input.toolsJsonEstimate, input.model, budgets)
    estimated = totalFromLayers(layers)

    if (estimated > window) {
      // Tighter keep set before fold so residual can land under the hard window.
      const keptForOverflow = await preserveRecentMessagesAsync(
        messages,
        Math.max(2, Math.floor(keepRecent / 2)),
        budgets.history,
        input.model
      )
      const toSummarize = messages.slice(0, Math.max(0, messages.length - keptForOverflow.length))
      if (await shouldCompactHistory(toSummarize, input.model)) {
        const foldTokens = await estimateMessagesTokensAsync(toSummarize, input.model)
        const keptTokens = await estimateMessagesTokensAsync(keptForOverflow, input.model)
        // Payback vs hard content window (not soft trigger) — we are already over window.
        const overflowPayback = shouldInvokeCompactionLlm({
          foldTokens,
          residualFloor: residualFloorAfterFold({
            keptTokens,
            systemTokens: layers.system,
            toolsTokens: input.toolsJsonEstimate || 0
          }),
          trigger: window,
          hasPriorLlmSummary: Boolean(
            compaction?.summary && !isTrimWatermarkCompaction(compaction)
          )
        })
        if (!overflowPayback.invokeLlm) {
          const retained = extractAskQuestionDecisions(toSummarize)
          messages = keptForOverflow
          contextShrunk = true
          systemParts.loopHint = combineLoopHints(
            systemParts.loopHint,
            loopHintForCompactionPaybackSkip(overflowPayback.reason),
            loopHintForRetainedDecisions(retained)
          )
          logger.info('Overflow compaction LLM skipped (payback gate)', {
            scope: 'agent',
            code: 'TOKEN_COST',
            reason: overflowPayback.reason,
            foldTokens,
            window,
            estimated,
            retainedDecisions: retained.length
          })
          zones = buildSystemZones({
            ...systemParts,
            compaction
          })
          layers = await computeLayers(
            zones.system,
            messages,
            input.toolsJsonEstimate,
            input.model,
            budgets
          )
          estimated = totalFromLayers(layers)
        } else {
          const record = await compactMessages({
            provider: input.provider,
            model: input.model.id,
            apiKey: input.apiKey,
            baseUrl: input.baseUrl,
            signal: input.signal,
            messages: stripThinkingForCompaction(toSummarize),
            supportsStructuredOutput: input.model.supportsStructuredOutput,
            contextWindow: window,
            priorSummary: isTrimWatermarkCompaction(compaction)
              ? undefined
              : compaction?.summary
          })
          if (record) {
            // Drop the folded prefix — mirror trigger-path `messages = keptForBoundary`.
            messages = keptForOverflow
            compaction = record
            contextShrunk = true
            zones = buildSystemZones({
              ...systemParts,
              compaction
            })
            layers = await computeLayers(
              zones.system,
              messages,
              input.toolsJsonEstimate,
              input.model,
              budgets
            )
            estimated = totalFromLayers(layers)
          }
        }
      }
    }

    if (estimated > window) {
      // Last-resort shrink before declaring overflow: drop thinking from the
      // wire set and keep only the latest tool result.
      const beforeLastResort = wireContentChars(messages)
      messages = stripThinkingForCompaction(messages)
      messages = trimToolResults(messages, KEEP_LAST_TOOL_RESULTS)
      if (wireContentChars(messages) !== beforeLastResort) contextShrunk = true
      zones = buildSystemZones({
        ...systemParts,
        compaction
      })
      layers = await computeLayers(zones.system, messages, input.toolsJsonEstimate, input.model, budgets)
      estimated = totalFromLayers(layers)
    }

    if (estimated > window) {
      logger.warn('Context still exceeds model window after compaction', {
        scope: 'agent',
        code: 'CONTEXT_OVERFLOW',
        estimated,
        window
      })
    }
  }

  perfLog('assembleContext', assembleStarted, {
    messages: messages.length,
    estimated,
    contextShrunk
  })

  return {
    system: zones.system,
    systemStable: zones.stable,
    systemVolatile: zones.volatile,
    messages,
    compaction,
    estimatedTokens: estimated,
    layers,
    contextShrunk,
    overflow: estimated > window,
    anthropicNative: anthropicNativeOptions(
      input.providerId,
      input.model,
      triggerRatio
    )
  }
}

/** Estimate tool definitions JSON size in tokens. */
export function estimateToolsJson(tools: unknown[]): number {
  try {
    return estimateTextTokens(JSON.stringify(tools))
  } catch {
    return 500
  }
}

export type { AssembleResult, CompactionRecord, ChatMessage }
