/* global localStorage, document */
;(function () {
  try {
    var raw = localStorage.getItem('vyotiq-appearance')
    if (!raw) return
    var cache = JSON.parse(raw)
    var root = document.documentElement
    if (cache.resolvedTheme === 'light' || cache.resolvedTheme === 'dark') {
      root.setAttribute('data-theme', cache.resolvedTheme)
    }
    if (cache.fontScale === 'small' || cache.fontScale === 'default' || cache.fontScale === 'large') {
      root.setAttribute('data-font-scale', cache.fontScale)
    }
    if (
      cache.uiDensity === 'compact' ||
      cache.uiDensity === 'default' ||
      cache.uiDensity === 'comfortable'
    ) {
      root.setAttribute('data-density', cache.uiDensity)
    }
    if (
      cache.accentPreset === 'neutral' ||
      cache.accentPreset === 'blue' ||
      cache.accentPreset === 'violet' ||
      cache.accentPreset === 'green'
    ) {
      root.setAttribute('data-accent', cache.accentPreset)
    }
  } catch {
    /* ignore corrupt cache */
  }
})()
