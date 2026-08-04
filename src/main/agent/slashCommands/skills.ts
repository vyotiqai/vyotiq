import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type {
  MarketplaceOverrides,
  SlashCommandDescriptor,
  SlashCommandResolveResult
} from '../../../shared/ipc'
import { formatSkillInvocation } from '../../../shared/slashCommands'
import { effectiveMarketplaceEnabled } from '../../../shared/domain/marketplaceEnablement'
import { parseSkillFrontmatter } from '../skills/parse'
import { isSkillMdFilename, resolveSkillMdPath } from '../skills/paths'
import { browseCatalog } from '../../marketplace/catalog'
import { readMarketplaceIndex } from '../../marketplace/indexStore'
import { findCatalogEntry, getPackageContents } from '../../marketplace/packageContents'
import { bundledPackagePath, resolveInstalledPackageRoot } from '../../marketplace/paths'
import { resolveInsidePackageRoot } from '../../marketplace/safePath'

type SkillCandidate = {
  id: string
  trigger: string
  label: string
  description: string
  packageId: string
  availability: SlashCommandDescriptor['availability']
  /** Absolute path to SKILL.md when known. */
  skillPath?: string
}

function skillPathForInstalled(packagePath: string, nestedRel?: string): string | undefined {
  let root: string
  try {
    root = resolveInstalledPackageRoot(packagePath)
  } catch {
    return undefined
  }
  if (nestedRel) {
    try {
      const nestedDir = resolveInsidePackageRoot(root, nestedRel)
      const fromDir = resolveSkillMdPath(nestedDir)
      if (fromDir) return fromDir
      if (existsSync(nestedDir) && isSkillMdFilename(nestedDir)) return nestedDir
    } catch {
      return undefined
    }
    return undefined
  }
  return resolveSkillMdPath(root)
}

function skillPathForBundled(bundledPath: string, nestedRel?: string): string | undefined {
  try {
    const root = bundledPackagePath(bundledPath)
    if (nestedRel) {
      return resolveSkillMdPath(join(root, nestedRel))
    }
    return resolveSkillMdPath(root)
  } catch {
    return undefined
  }
}

function readSkillBody(path: string): { name: string; description: string; body: string } | null {
  try {
    const parsed = parseSkillFrontmatter(readFileSync(path, 'utf8'))
    return { name: parsed.name, description: parsed.description, body: parsed.body }
  } catch {
    return null
  }
}

/** List skill slash commands from catalog + installed packages. */
export async function listSkillCommands(
  marketplaceOverrides?: MarketplaceOverrides | null
): Promise<SlashCommandDescriptor[]> {
  const index = readMarketplaceIndex()
  const installedById = new Map(index.items.map((item) => [item.id, item]))
  const byTrigger = new Map<string, SkillCandidate>()

  const upsert = (candidate: SkillCandidate): void => {
    const key = candidate.trigger.toLowerCase()
    const prev = byTrigger.get(key)
    // Prefer ready > disabled > not_installed
    const rank = (a: SkillCandidate['availability']): number =>
      a === 'ready' ? 3 : a === 'disabled' ? 2 : 1
    if (!prev || rank(candidate.availability) > rank(prev.availability)) {
      byTrigger.set(key, candidate)
    }
  }

  // Installed standalone skills
  for (const item of index.items) {
    if (item.kind !== 'skill') continue
    const enabled = effectiveMarketplaceEnabled(
      item.id,
      item.enabled,
      marketplaceOverrides,
      'skills'
    )
    const path = skillPathForInstalled(item.packagePath)
    const loaded = path ? readSkillBody(path) : null
    const trigger = (loaded?.name ?? item.id).toLowerCase()
    upsert({
      id: `skill:${item.id}`,
      trigger,
      label: loaded?.name ?? item.name,
      description: loaded?.description ?? item.description,
      packageId: item.id,
      availability: enabled ? 'ready' : 'disabled',
      skillPath: path
    })
  }

  // Installed plugin skills
  for (const item of index.items) {
    if (item.kind !== 'plugin') continue
    const enabled = effectiveMarketplaceEnabled(
      item.id,
      item.enabled,
      marketplaceOverrides,
      'plugins'
    )
    const contents = getPackageContents(item.id)
    for (const skill of contents?.skills ?? []) {
      const path = skillPathForInstalled(item.packagePath, skill.path || undefined)
      const trigger = skill.name.toLowerCase()
      upsert({
        id: `skill:${item.id}/${skill.name}`,
        trigger,
        label: skill.name,
        description: skill.description,
        packageId: item.id,
        availability: enabled ? 'ready' : 'disabled',
        skillPath: path
      })
    }
  }

  // Catalog entries (skills + plugins) for not_installed / fill gaps
  const catalog = await browseCatalog()
  for (const entry of catalog) {
    if (entry.kind === 'skill') {
      if (installedById.has(entry.id)) continue
      const contents = getPackageContents(entry.id)
      const skill = contents?.skills[0]
      const trigger = (skill?.name ?? entry.id).toLowerCase()
      let skillPath: string | undefined
      if (entry.bundledPath) {
        skillPath = skillPathForBundled(entry.bundledPath)
      }
      upsert({
        id: `skill:${entry.id}`,
        trigger,
        label: skill?.name ?? entry.name,
        description: skill?.description ?? entry.description,
        packageId: entry.id,
        availability: 'not_installed',
        skillPath
      })
      continue
    }
    if (entry.kind === 'plugin') {
      const contents = getPackageContents(entry.id)
      for (const skill of contents?.skills ?? []) {
        const key = skill.name.toLowerCase()
        if (byTrigger.has(key)) continue
        let skillPath: string | undefined
        if (entry.bundledPath && skill.path) {
          skillPath = skillPathForBundled(entry.bundledPath, skill.path)
        }
        upsert({
          id: `skill:${entry.id}/${skill.name}`,
          trigger: key,
          label: skill.name,
          description: skill.description,
          packageId: entry.id,
          availability: installedById.has(entry.id)
            ? effectiveMarketplaceEnabled(
                entry.id,
                installedById.get(entry.id)!.enabled,
                marketplaceOverrides,
                'plugins'
              )
              ? 'ready'
              : 'disabled'
            : 'not_installed',
          skillPath
        })
      }
    }
  }

  return [...byTrigger.values()]
    .sort((a, b) => a.trigger.localeCompare(b.trigger))
    .map((c) => ({
      id: c.id,
      trigger: c.trigger,
      label: c.label,
      description: c.description,
      kind: 'skill' as const,
      group: 'Skills',
      availability: c.availability,
      packageId: c.packageId
    }))
}

function resolveSkillPath(id: string): string | null {
  // id: skill:{packageId} or skill:{packageId}/{skillName}
  if (!id.startsWith('skill:')) return null
  const rest = id.slice('skill:'.length)
  const slash = rest.indexOf('/')
  const packageId = slash >= 0 ? rest.slice(0, slash) : rest
  const skillName = slash >= 0 ? rest.slice(slash + 1) : null

  const index = readMarketplaceIndex()
  const item = index.items.find((i) => i.id === packageId)
  if (item) {
    if (item.kind === 'skill') {
      return skillPathForInstalled(item.packagePath) ?? null
    }
    if (item.kind === 'plugin' && skillName) {
      const contents = getPackageContents(item.id)
      const match = contents?.skills.find((s) => s.name === skillName)
      return skillPathForInstalled(item.packagePath, match?.path || skillName) ?? null
    }
  }

  const entry = findCatalogEntry(packageId)
  if (entry?.bundledPath) {
    if (entry.kind === 'skill') {
      return skillPathForBundled(entry.bundledPath) ?? null
    }
    if (skillName) {
      const contents = getPackageContents(packageId)
      const match = contents?.skills.find((s) => s.name === skillName)
      if (match?.path) {
        return skillPathForBundled(entry.bundledPath, match.path) ?? null
      }
    }
  }
  return null
}

export function resolveSkillCommand(
  id: string,
  trailingText: string,
  marketplaceOverrides?: MarketplaceOverrides | null
): SlashCommandResolveResult | null {
  if (!id.startsWith('skill:')) return null

  const rest = id.slice('skill:'.length)
  const slash = rest.indexOf('/')
  const packageId = slash >= 0 ? rest.slice(0, slash) : rest
  const index = readMarketplaceIndex()
  const item = index.items.find((i) => i.id === packageId)
  if (!item) {
    return { action: 'marketplace', packageId, intent: 'install' }
  }
  const kind = item.kind === 'plugin' ? 'plugins' : 'skills'
  const enabled = effectiveMarketplaceEnabled(
    item.id,
    item.enabled,
    marketplaceOverrides,
    kind
  )
  if (!enabled) {
    return { action: 'marketplace', packageId, intent: 'enable' }
  }

  const path = resolveSkillPath(id)
  if (!path) {
    return { action: 'marketplace', packageId, intent: 'install' }
  }
  const loaded = readSkillBody(path)
  if (!loaded) {
    return {
      action: 'send',
      message: `Could not load skill for /${packageId}.`
    }
  }
  return {
    action: 'send',
    message: formatSkillInvocation(loaded.name, loaded.body, trailingText)
  }
}
