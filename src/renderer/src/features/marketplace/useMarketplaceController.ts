import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  MarketplaceCatalogEntry,
  MarketplaceIndex,
  MarketplaceInstalledItem,
  MarketplaceInstallRequest,
  MarketplaceKind,
  McpApplyDetectedRequest,
  McpDetectResult,
  McpImportExternalRequest,
  McpImportExternalResult,
  McpServerStatus,
  Settings
} from '@shared/ipc'

export type MarketplaceFeedback = { kind: 'success' | 'error' | 'warning'; text: string }

const REMOTE_INSTALL_SOURCES = new Set(['registry', 'git', 'npm', 'zip', 'remote', 'path'])
const QUERY_DEBOUNCE_MS = 250

export function useMarketplaceController({
  settings,
  onUpdate,
  onReloadSettings,
  activeWorkspacePath
}: {
  settings: Settings
  onUpdate: (partial: Partial<Settings>) => Promise<{ ok: true } | { ok: false; error: string }>
  /** Reload settings from main after marketplace mutations that write mcpServers on disk. */
  onReloadSettings?: () => Promise<void>
  activeWorkspacePath?: string | null
}) {
  const [kindFilter, setKindFilter] = useState<MarketplaceKind | 'all'>('all')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [catalog, setCatalog] = useState<MarketplaceCatalogEntry[]>([])
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [installed, setInstalled] = useState<MarketplaceIndex>({ schemaVersion: 1, items: [] })
  const [busy, setBusy] = useState(false)
  const busyDepthRef = useRef(0)
  const beginBusy = useCallback(() => {
    busyDepthRef.current += 1
    if (busyDepthRef.current === 1) setBusy(true)
  }, [])
  const endBusy = useCallback(() => {
    busyDepthRef.current = Math.max(0, busyDepthRef.current - 1)
    if (busyDepthRef.current === 0) setBusy(false)
  }, [])
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedbackState] = useState<MarketplaceFeedback | null>(null)
  const feedbackSeqRef = useRef(0)
  /** Bump seq so overlapping ops cannot wipe a newer message with a stale success/error. */
  const setFeedback = useCallback((fb: MarketplaceFeedback | null): number => {
    const seq = ++feedbackSeqRef.current
    setFeedbackState(fb)
    return seq
  }, [])
  const setFeedbackIfCurrent = useCallback((seq: number, fb: MarketplaceFeedback | null): boolean => {
    if (seq !== feedbackSeqRef.current) return false
    setFeedbackState(fb)
    return true
  }, [])
  const [mcpStatus, setMcpStatus] = useState<McpServerStatus[]>([])
  const [mcpStatusLoading, setMcpStatusLoading] = useState(false)
  const mcpStatusReqIdRef = useRef(0)
  const reloadReqIdRef = useRef(0)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), QUERY_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  const mcpStatusById = useMemo(() => {
    const map = new Map<string, McpServerStatus>()
    for (const row of mcpStatus) map.set(row.id, row)
    return map
  }, [mcpStatus])

  const installedIds = useMemo(() => new Set(installed.items.map((i) => i.id)), [installed.items])

  const formLocked = busy || saving

  const loadMcpStatus = useCallback(async (refresh = false): Promise<void> => {
    if (!window.vyotiq.mcpStatus) return
    const reqId = ++mcpStatusReqIdRef.current
    setMcpStatusLoading(true)
    try {
      const payload = { workspacePath: activeWorkspacePath ?? null }
      const res =
        refresh && window.vyotiq.mcpRefresh
          ? await window.vyotiq.mcpRefresh(payload)
          : await window.vyotiq.mcpStatus(payload)
      if (reqId !== mcpStatusReqIdRef.current) return
      if (res.ok) setMcpStatus(res.data.servers)
      else {
        setFeedback({
          kind: 'error',
          text: res.code ? `${res.error} (${res.code})` : res.error
        })
      }
    } finally {
      if (reqId === mcpStatusReqIdRef.current) setMcpStatusLoading(false)
    }
  }, [activeWorkspacePath, setFeedback])

  const runUpdate = useCallback(
    async (partial: Partial<Settings>): Promise<boolean> => {
      setSaving(true)
      try {
        const res = await onUpdate(partial)
        if (!res.ok) {
          setFeedback({ kind: 'error', text: res.error })
          return false
        }
        return true
      } finally {
        setSaving(false)
      }
    },
    [onUpdate, setFeedback]
  )

  const reload = useCallback(async () => {
    const reqId = ++reloadReqIdRef.current
    setCatalogLoading(true)
    try {
      const [browseRes, installedRes] = await Promise.all([
        window.vyotiq.marketplaceBrowse(
          kindFilter === 'all'
            ? { q: debouncedQuery || undefined }
            : { kind: kindFilter, q: debouncedQuery || undefined }
        ),
        window.vyotiq.marketplaceListInstalled()
      ])
      if (reqId !== reloadReqIdRef.current) return
      if (browseRes.ok) setCatalog(browseRes.data.packages)
      else setFeedback({ kind: 'error', text: browseRes.error })
      if (installedRes.ok) setInstalled(installedRes.data)
      else setFeedback({ kind: 'error', text: installedRes.error })
    } finally {
      if (reqId === reloadReqIdRef.current) setCatalogLoading(false)
    }
  }, [kindFilter, debouncedQuery, setFeedback])

  const refreshCatalog = useCallback(async () => {
    setCatalogLoading(true)
    setFeedback(null)
    try {
      const registryUrl = (settings.marketplace?.registryUrl ?? '').trim()
      if (registryUrl && window.vyotiq.marketplaceRefreshCatalog) {
        const refreshRes = await window.vyotiq.marketplaceRefreshCatalog()
        if (!refreshRes.ok) {
          setFeedback({ kind: 'error', text: refreshRes.error })
        }
      }
      await reload()
    } finally {
      setCatalogLoading(false)
    }
  }, [reload, settings.marketplace?.registryUrl])

  useEffect(() => {
    void reload()
  }, [reload, settings.marketplace?.registryUrl])

  useEffect(() => {
    const onCatalogRefreshed = (): void => {
      void reload()
    }
    window.addEventListener('vyotiq:marketplace-catalog-refreshed', onCatalogRefreshed)
    return () => {
      window.removeEventListener('vyotiq:marketplace-catalog-refreshed', onCatalogRefreshed)
    }
  }, [reload])

  useEffect(() => {
    // Refresh connections on open so connect errors / recovery are visible.
    void loadMcpStatus(true)
  }, [loadMcpStatus, installed.items.length, settings.mcpServers])

  const ensureRemoteAck = useCallback(async (): Promise<boolean> => {
    if (settings.marketplace?.remoteInstallAcked) return true
    const res = await window.vyotiq.marketplaceAckRemoteInstall(true)
    if (!res.ok) return false
    if (!res.data.marketplace?.remoteInstallAcked) return false
    await onReloadSettings?.()
    return true
  }, [onReloadSettings, settings.marketplace?.remoteInstallAcked])

  const runInstall = useCallback(
    async (payload: MarketplaceInstallRequest): Promise<boolean> => {
      beginBusy()
      const epoch = setFeedback(null)
      try {
        if (REMOTE_INSTALL_SOURCES.has(payload.source)) {
          const acked = await ensureRemoteAck()
          if (!acked) return false
        }
        const res = await window.vyotiq.marketplaceInstall(payload)
        if (!res.ok) {
          setFeedbackIfCurrent(epoch, { kind: 'error', text: res.error })
          return false
        }
        const { item, authTokenStored } = res.data
        let tokenHint = ''
        if (payload.source === 'remote' && payload.bearerToken?.trim()) {
          tokenHint =
            authTokenStored === false
              ? ' Warning: Bearer token could not be stored in OS secure storage — configure auth under Installed.'
              : ' Bearer token stored in OS secure storage.'
        }
        setFeedbackIfCurrent(epoch, {
          kind: authTokenStored === false ? 'error' : 'success',
          text: `Installed ${item.name} (${item.kind}) — enabled by default; tools load into the agent when connected.${tokenHint}`
        })
        await reload()
        await onReloadSettings?.()
        await loadMcpStatus(true)
        return true
      } finally {
        endBusy()
      }
    },
    [
      ensureRemoteAck,
      loadMcpStatus,
      onReloadSettings,
      reload,
      beginBusy,
      endBusy,
      setFeedback,
      setFeedbackIfCurrent
    ]
  )

  const installFromCatalog = useCallback(
    async (entry: MarketplaceCatalogEntry): Promise<boolean> => {
      if (entry.installable === false) return false
      if (entry.bundledPath) {
        return runInstall({
          source: 'bundled',
          target: entry.bundledPath,
          kind: entry.kind
        })
      }
      return runInstall({
        source: 'registry',
        target: entry.id,
        kind: entry.kind
      })
    },
    [runInstall]
  )

  const setEnabled = useCallback(
    async (item: MarketplaceInstalledItem, enabled: boolean) => {
      beginBusy()
      const epoch = ++feedbackSeqRef.current
      try {
        const res = await window.vyotiq.marketplaceSetEnabled(item.id, enabled)
        if (!res.ok) {
          setFeedback({ kind: 'error', text: res.error })
          return
        }
        setInstalled(res.data)
        if (item.kind === 'mcp' || item.kind === 'plugin') {
          await onReloadSettings?.()
          await loadMcpStatus(true)
          setFeedbackIfCurrent(epoch, {
            kind: 'success',
            text: enabled
              ? `${item.name} enabled — connecting and loading tools for the agent.`
              : `${item.name} disabled.`
          })
        } else {
          setFeedbackIfCurrent(epoch, {
            kind: 'success',
            text: enabled ? `${item.name} enabled.` : `${item.name} disabled.`
          })
        }
      } finally {
        endBusy()
      }
    },
    [loadMcpStatus, onReloadSettings, beginBusy, endBusy, setFeedback, setFeedbackIfCurrent]
  )

  const uninstall = useCallback(
    async (id: string) => {
      if (!window.confirm('Uninstall this package? Auth secrets for its MCP servers will be cleared.')) {
        return
      }
      beginBusy()
      const epoch = ++feedbackSeqRef.current
      try {
        const res = await window.vyotiq.marketplaceUninstall(id)
        if (!res.ok) {
          setFeedback({ kind: 'error', text: res.error })
          return
        }
        setInstalled(res.data)
        setFeedbackIfCurrent(epoch, { kind: 'success', text: 'Uninstalled' })
        await onReloadSettings?.()
        await loadMcpStatus(true)
      } finally {
        endBusy()
      }
    },
    [loadMcpStatus, onReloadSettings, beginBusy, endBusy, setFeedback, setFeedbackIfCurrent]
  )

  const detectMcp = useCallback(
    async (input: string): Promise<McpDetectResult | null> => {
      beginBusy()
      setFeedback(null)
      try {
        const trimmed = input.trim()
        // Match main `classifyMcpInput` ack gates: git / npm / remote / JSON configs.
        // Plain stdio launcher lines (npx/uvx/…) ack at apply time, not detect.
        const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[')
        const looksLikeGit =
          /^git@|^ssh:\/\/|^git:\/\//i.test(trimmed) ||
          /\.git$/i.test(trimmed) ||
          /^https?:\/\/(www\.)?(github\.com|gitlab\.com|bitbucket\.org)\b/i.test(trimmed)
        const looksLikeRemote =
          /^https?:\/\//i.test(trimmed) && !looksLikeGit
        const looksLikeNpm =
          !looksLikeJson &&
          !/\s/.test(trimmed) &&
          /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(trimmed)
        if (looksLikeJson || looksLikeGit || looksLikeRemote || looksLikeNpm) {
          const acked = await ensureRemoteAck()
          if (!acked) return null
        }
        const res = await window.vyotiq.marketplaceDetectMcp({ input: trimmed })
        if (!res.ok) {
          setFeedback({ kind: 'error', text: res.error })
          return null
        }
        return res.data
      } finally {
        endBusy()
      }
    },
    [ensureRemoteAck, beginBusy, endBusy]
  )

  const applyDetectedMcp = useCallback(
    async (payload: McpApplyDetectedRequest): Promise<boolean> => {
      beginBusy()
      const epoch = setFeedback(null)
      try {
        const acked = await ensureRemoteAck()
        if (!acked) return false
        const res = await window.vyotiq.marketplaceApplyDetectedMcp(payload)
        if (!res.ok) {
          setFeedbackIfCurrent(epoch, { kind: 'error', text: res.error })
          return false
        }
        setFeedbackIfCurrent(epoch, {
          kind: 'success',
          text:
            res.data.applied === 'marketplace'
              ? 'Installed package — tools load into the agent when connected.'
              : 'MCP added — connecting and loading tools for the agent.'
        })
        await reload()
        await onReloadSettings?.()
        await loadMcpStatus(true)
        return true
      } finally {
        endBusy()
      }
    },
    [
      ensureRemoteAck,
      loadMcpStatus,
      onReloadSettings,
      reload,
      beginBusy,
      endBusy,
      setFeedback,
      setFeedbackIfCurrent
    ]
  )

  const scanExternalMcp = useCallback(
    async (paths?: string[]): Promise<McpImportExternalResult | null> => {
      beginBusy()
      setFeedback(null)
      try {
        const res = await window.vyotiq.marketplaceScanExternalMcp(
          paths?.length ? { paths } : {}
        )
        if (!res.ok) {
          setFeedback({ kind: 'error', text: res.error })
          return null
        }
        if (res.data.warnings.length > 0) {
          setFeedback({
            kind: 'warning',
            text: res.data.warnings.slice(0, 3).join(' ')
          })
        }
        return res.data
      } finally {
        endBusy()
      }
    },
    [beginBusy, endBusy]
  )

  const importExternalMcp = useCallback(
    async (payload: McpImportExternalRequest): Promise<boolean> => {
      beginBusy()
      setFeedback(null)
      try {
        const acked = await ensureRemoteAck()
        if (!acked) return false
        const res = await window.vyotiq.marketplaceImportExternalMcp(payload)
        if (!res.ok) {
          setFeedback({ kind: 'error', text: res.error })
          return false
        }
        const warnSuffix =
          res.data.warnings.length > 0
            ? ` Warnings: ${res.data.warnings.slice(0, 2).join(' ')}`
            : ''
        setFeedback({
          kind: res.data.warnings.length > 0 ? 'error' : 'success',
          text: `Imported ${res.data.applied} MCP server${res.data.applied === 1 ? '' : 's'} (${res.data.skipped} skipped).${warnSuffix}`
        })
        await reload()
        await onReloadSettings?.()
        await loadMcpStatus(true)
        return true
      } finally {
        endBusy()
      }
    },
    [ensureRemoteAck, loadMcpStatus, onReloadSettings, reload, beginBusy, endBusy]
  )

  return {
    kindFilter,
    setKindFilter,
    query,
    setQuery,
    catalog,
    catalogLoading,
    setCatalog,
    installed,
    installedIds,
    busy,
    formLocked,
    feedback,
    setFeedback,
    mcpStatusById,
    mcpStatusLoading,
    loadMcpStatus,
    runUpdate,
    reload,
    refreshCatalog,
    runInstall,
    installFromCatalog,
    setEnabled,
    uninstall,
    detectMcp,
    applyDetectedMcp,
    scanExternalMcp,
    importExternalMcp
  }
}

export type MarketplaceController = ReturnType<typeof useMarketplaceController>
