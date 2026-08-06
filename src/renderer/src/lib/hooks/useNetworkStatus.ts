import { useCallback, useEffect, useState } from 'react'

const PROBE_INTERVAL_MS = 15_000

async function probeViaMain(): Promise<boolean | null> {
  if (typeof window === 'undefined' || !window.vyotiq?.probeNetwork) return null
  try {
    const res = await window.vyotiq.probeNetwork()
    if (res.ok) return res.data
  } catch {
    // Fall through to navigator.onLine
  }
  return null
}

export function useNetworkStatus(): { online: boolean; offlineHint: string | null } {
  const [online, setOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  )

  const refresh = useCallback(async (): Promise<void> => {
    const probed = await probeViaMain()
    if (probed !== null) {
      setOnline(probed)
      return
    }
    if (typeof navigator !== 'undefined') {
      setOnline(navigator.onLine)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const onBrowserChange = (): void => {
      void refresh()
    }
    window.addEventListener('online', onBrowserChange)
    window.addEventListener('offline', onBrowserChange)
    const timer = window.setInterval(() => {
      void refresh()
    }, PROBE_INTERVAL_MS)
    return () => {
      window.removeEventListener('online', onBrowserChange)
      window.removeEventListener('offline', onBrowserChange)
      window.clearInterval(timer)
    }
  }, [refresh])

  return {
    online,
    offlineHint: online
      ? null
      : 'You appear to be offline. Agent runs will retry when connectivity returns.'
  }
}
