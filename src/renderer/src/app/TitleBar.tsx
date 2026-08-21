import { useEffect, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { VyotiqMark } from '@renderer/lib/brand'
import { IconButton, cn } from '@renderer/lib/ui'
import { TITLE_BAR_HEIGHT, showsWindowControls } from '@renderer/lib/utils/layout'
import { useIsDesktop } from '@renderer/lib/context/BreakpointProvider'
import { useTitleBarAccessory } from '@renderer/lib/context/TitleBarAccessory'
import { MACOS_TITLEBAR_INSET_PX } from '@shared/windowChrome'

function useShowWindowControls(): boolean {
  return showsWindowControls()
}

function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    const api = window.vyotiq
    if (!api?.windowIsMaximized) return
    void api.windowIsMaximized().then((res) => {
      if (res.ok) setMaximized(res.data)
    })
    if (!api.onWindowMaximizedChanged) return
    return api.onWindowMaximizedChanged(setMaximized)
  }, [])

  return maximized
}

const winBtn =
  'inline-grid h-full min-w-9 w-10 place-items-center text-fg vy-transition hover:bg-surface active:bg-surface-2 sm:w-11'

export function TitleBar({
  drawerOpen,
  onToggleSidebar
}: {
  drawerOpen: boolean
  onToggleSidebar: () => void
}) {
  const isDesktop = useIsDesktop()
  const showControls = useShowWindowControls()
  const maximized = useMaximized()
  const isDarwin = window.vyotiq?.platform === 'darwin'
  const { setHost, occupied } = useTitleBarAccessory()

  return (
    <header
      className={cn(
        'app-region-drag z-sticky flex shrink-0 items-stretch bg-bg',
        occupied ? 'border-b-0' : 'border-b border-border/30',
        TITLE_BAR_HEIGHT,
        showControls ? 'pr-0' : 'pr-2'
      )}
      style={!isDesktop && isDarwin ? { paddingLeft: MACOS_TITLEBAR_INSET_PX } : undefined}
      data-titlebar
      aria-label="Window title bar"
    >
      {/* Mobile only: open navigation when the drawer is closed.
          Desktop toggle lives inside the sidebar header. */}
      {!isDesktop ? (
        <div className="app-region-no-drag flex shrink-0 items-center pl-1.5">
          <IconButton
            icon="menu"
            label={drawerOpen ? 'Close menu' : 'Open menu'}
            variant="bare"
            aria-controls="app-nav-drawer"
            aria-expanded={drawerOpen}
            onClick={onToggleSidebar}
          />
        </div>
      ) : null}

      <div
        ref={setHost}
        className={cn(
          'min-w-0 flex-1 self-stretch',
          // Keep the host draggable; DockTabBar marks only interactive clusters no-drag
          // so the middle spacer remains a real window-drag region.
          occupied && 'flex items-stretch'
        )}
        data-titlebar-accessory
        role={occupied ? undefined : 'presentation'}
        aria-hidden={occupied ? undefined : true}
        onDoubleClick={() => {
          if (!occupied && showControls) void window.vyotiq?.windowMaximize()
        }}
      >
        {!isDesktop && !drawerOpen && !occupied ? (
          <div className="pointer-events-none flex h-full items-center justify-center" aria-hidden>
            <VyotiqMark size={17} className="text-fg/70" decorative />
          </div>
        ) : null}
      </div>

      {showControls ? (
        <div className="app-region-no-drag flex shrink-0 items-stretch" data-titlebar-controls>
          <button
            type="button"
            className={winBtn}
            aria-label="Minimize"
            title="Minimize"
            onClick={() => void window.vyotiq?.windowMinimize()}
          >
            <Icon name="minimize" size={16} />
          </button>
          <button
            type="button"
            className={winBtn}
            aria-label={maximized ? 'Restore' : 'Maximize'}
            title={maximized ? 'Restore' : 'Maximize'}
            onClick={() => void window.vyotiq?.windowMaximize()}
          >
            <Icon name={maximized ? 'restore' : 'maximize'} size={16} />
          </button>
          <button
            type="button"
            className={cn(winBtn, 'hover:bg-window-close hover:text-white')}
            aria-label="Close"
            title="Close"
            onClick={() => void window.vyotiq?.windowClose()}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      ) : null}
    </header>
  )
}
