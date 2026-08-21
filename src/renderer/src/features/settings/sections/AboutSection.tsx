import { useEffect, useRef, useState } from 'react'
import type { AppInfo } from '@shared/ipc'
import { VyotiqLockup } from '@renderer/lib/brand'
import { Button } from '@renderer/lib/ui'
import { copyText } from '@renderer/lib/markdown/copyText'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'

function platformLabel(platform: string, arch: string, osVersion: string): string {
  let os: string
  switch (platform) {
    case 'win32':
      os = 'Windows'
      break
    case 'darwin':
      os = 'macOS'
      break
    case 'linux':
      os = 'Linux'
      break
    default:
      os = platform
      break
  }
  return `${os} ${arch} · ${osVersion}`
}

function websiteHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function buildInfoText(info: AppInfo): string {
  return [
    `${info.name} ${info.version}`,
    `Electron ${info.electron}`,
    `Chromium ${info.chrome}`,
    `Node.js ${info.node}`,
    `Platform ${info.platform} ${info.arch} (${info.osVersion})`,
    info.homepage
  ].join('\n')
}

export function AboutSection({ form }: { form: SettingsFormState }) {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [copied, setCopied] = useState(false)
  const [openingSite, setOpeningSite] = useState(false)
  const [openingDocs, setOpeningDocs] = useState(false)
  const setErrorMessage = form.setErrorMessage
  const setErrorRef = useRef(setErrorMessage)
  setErrorRef.current = setErrorMessage
  const copyTimerRef = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const api = window.vyotiq?.getAppInfo
    if (!api) return
    void api().then((res) => {
      if (cancelled) return
      if (!res.ok) {
        setErrorRef.current(res.error)
        return
      }
      setInfo(res.data)
    })
    return () => {
      cancelled = true
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current)
    }
  }, [])

  const dash = '—'
  const year = new Date().getFullYear()

  return (
    <SettingsStack>
      <div data-settings-field="about" className="flex flex-col gap-2 px-0.5 pb-1">
        <VyotiqLockup markSize={36} />
        <p className="m-0 text-xs leading-snug tracking-[var(--vy-tracking)] text-secondary">
          Agent V. A product of Vyotiq.com.
        </p>
        <p className="m-0 text-xs leading-snug tracking-[var(--vy-tracking)] text-muted">
          © {year} Vyotiq
        </p>
      </div>

      <SettingsGroup title="Build">
        <SettingsField
          id="about-version"
          title="Version"
          hint="Product version for this install."
        >
          <p className="m-0 text-sm tabular-nums tracking-[var(--vy-tracking)] text-fg">
            {info?.version ?? dash}
          </p>
        </SettingsField>
        <SettingsField
          id="about-runtime"
          title="Runtime"
          hint="Electron host, Chromium, and Node.js shipped in this app."
          wide
        >
          <dl className="m-0 grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm tracking-[var(--vy-tracking)]">
            <dt className="text-secondary">Electron</dt>
            <dd className="m-0 min-w-0 tabular-nums text-fg">{info?.electron ?? dash}</dd>
            <dt className="text-secondary">Chromium</dt>
            <dd className="m-0 min-w-0 break-all tabular-nums text-fg">{info?.chrome ?? dash}</dd>
            <dt className="text-secondary">Node.js</dt>
            <dd className="m-0 min-w-0 tabular-nums text-fg">{info?.node ?? dash}</dd>
          </dl>
        </SettingsField>
        <SettingsField
          id="about-platform"
          title="Platform"
          hint="Operating system and architecture reported by the host."
        >
          <p className="m-0 max-w-full text-right text-sm tracking-[var(--vy-tracking)] text-fg [overflow-wrap:anywhere]">
            {info ? platformLabel(info.platform, info.arch, info.osVersion) : dash}
          </p>
        </SettingsField>
        <SettingsField
          id="about-copy"
          title="Build info"
          hint="Copy version and runtime lines for a bug report."
        >
          <Button
            variant="subtle"
            disabled={!info}
            onClick={() => {
              if (!info) return
              void copyText(buildInfoText(info)).then((ok) => {
                if (!ok) {
                  form.setErrorMessage('Could not copy build info.')
                  return
                }
                setCopied(true)
                if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current)
                copyTimerRef.current = window.setTimeout(() => setCopied(false), 1200)
              })
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Links">
        <SettingsField
          id="about-website"
          title="Website"
          hint={info ? websiteHost(info.homepage) : 'vyotiq.com'}
        >
          <Button
            variant="subtle"
            pending={openingSite}
            disabled={!info}
            onClick={() => {
              if (!info || !window.vyotiq?.shellOpenExternal) return
              form.clearErrors()
              setOpeningSite(true)
              void window.vyotiq
                .shellOpenExternal(info.homepage)
                .then((res) => {
                  if (!res.ok) form.setErrorMessage(res.error)
                })
                .finally(() => setOpeningSite(false))
            }}
          >
            {openingSite ? 'Opening…' : 'Open'}
          </Button>
        </SettingsField>
        <SettingsField
          id="about-docs"
          title="Docs"
          hint={info ? `${websiteHost(info.homepage)}/docs` : 'vyotiq.com/docs'}
        >
          <Button
            variant="subtle"
            pending={openingDocs}
            disabled={!info}
            onClick={() => {
              if (!info || !window.vyotiq?.shellOpenExternal) return
              form.clearErrors()
              setOpeningDocs(true)
              void window.vyotiq
                .shellOpenExternal(new URL('/docs', info.homepage).href)
                .then((res) => {
                  if (!res.ok) form.setErrorMessage(res.error)
                })
                .finally(() => setOpeningDocs(false))
            }}
          >
            {openingDocs ? 'Opening…' : 'Open'}
          </Button>
        </SettingsField>
      </SettingsGroup>
    </SettingsStack>
  )
}
