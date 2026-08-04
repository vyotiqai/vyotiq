import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import {
  createChatStreamController,
  type ChatStreamController
} from './createChatStreamController'

/**
 * Thin React wrapper around {@link createChatStreamController} for tests and single-workspace use.
 * Production UI should prefer {@link useWorkspaceManager} for parallel workspace contexts.
 */
export function useChatStream(workspacePath: string | null) {
  const controllerRef = useRef<ChatStreamController | null>(null)
  const pathRef = useRef(workspacePath)

  if (!controllerRef.current || pathRef.current !== workspacePath) {
    controllerRef.current?.dispose()
    controllerRef.current = createChatStreamController({
      workspacePath: workspacePath ?? ''
    })
    pathRef.current = workspacePath
  }

  const controller = controllerRef.current

  const subscribe = useCallback(
    (onStoreChange: () => void) => controller.subscribe(onStoreChange),
    [controller]
  )

  const getRevision = useCallback(() => controllerRef.current?.getRevision() ?? 0, [])

  useSyncExternalStore(subscribe, getRevision, getRevision)

  useEffect(() => {
    if (!window.vyotiq?.onChatEvent) return
    return window.vyotiq.onChatEvent((event) => {
      controllerRef.current?.handleEvent(event)
    })
  }, [controller])

  useEffect(() => {
    if (!window.vyotiq?.onToolApprovalRequest) return
    return window.vyotiq.onToolApprovalRequest((request) => {
      controllerRef.current?.handleApprovalRequest(request)
    })
  }, [controller])

  useEffect(() => {
    if (!window.vyotiq?.onAgentQuestionRequest) return
    return window.vyotiq.onAgentQuestionRequest((request) => {
      controllerRef.current?.handleQuestionRequest(request)
    })
  }, [controller])

  useEffect(() => {
    return () => controllerRef.current?.dispose()
  }, [])

  return {
    items: controller.items,
    messages: controller.messages,
    running: controller.running,
    runId: controller.runId,
    error: controller.error,
    runNotice: controller.runNotice,
    incomplete: controller.incomplete,
    contextUsage: controller.contextUsage,
    runStartedAt: controller.runStartedAt,
    runTerminalTick: controller.runTerminalTick,
    pendingRun: controller.pendingRun,
    transcriptLoading: controller.transcriptLoading,
    collapsedTurnIndices: controller.collapsedTurnIndices,
    pendingFollowUps: controller.pendingFollowUps,
    clearError: controller.clearError.bind(controller),
    send: controller.send.bind(controller),
    removeFollowUp: controller.removeFollowUp.bind(controller),
    stop: controller.stop.bind(controller),
    reset: controller.reset.bind(controller),
    loadTranscript: controller.loadTranscript.bind(controller),
    hydrateTranscript: controller.hydrateTranscript.bind(controller),
    syncFromDisk: controller.syncFromDisk.bind(controller),
    loadToolContent: controller.loadToolContent.bind(controller),
    toggleTurnCollapsed: controller.toggleTurnCollapsed.bind(controller),
    handleApprovalRequest: controller.handleApprovalRequest.bind(controller),
    respondToApproval: controller.respondToApproval.bind(controller),
    handleQuestionRequest: controller.handleQuestionRequest.bind(controller),
    respondToQuestion: controller.respondToQuestion.bind(controller)
  }
}
