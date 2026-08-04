import type { MarketplaceOverrides } from '../ipc'

/** Resolve effective enablement: workspace override wins when present. */
export function effectiveMarketplaceEnabled(
  id: string,
  globalEnabled: boolean,
  overrides: MarketplaceOverrides | null | undefined,
  kind: 'mcp' | 'skills' | 'plugins'
): boolean {
  const map = overrides?.[kind]
  if (map && Object.prototype.hasOwnProperty.call(map, id)) {
    return map[id] === true
  }
  return globalEnabled
}
