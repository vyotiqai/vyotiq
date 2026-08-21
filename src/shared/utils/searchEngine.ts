import type { SearchEngineId } from '../ipc/schemas/settings'

export function buildSearchUrl(engine: SearchEngineId, query: string): string {
  const q = encodeURIComponent(query.trim())
  switch (engine) {
    case 'bing':
      return `https://www.bing.com/search?q=${q}`
    case 'google':
      return `https://www.google.com/search?q=${q}`
    case 'duckduckgo':
    default:
      return `https://duckduckgo.com/?q=${q}`
  }
}
