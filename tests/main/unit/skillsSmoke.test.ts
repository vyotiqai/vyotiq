/**
 * Smoke: Agent Skills alignment against real bundled packages (isolated temp userData).
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync } from 'fs'

const REPO = process.cwd()
const PACKAGES = join(REPO, 'resources', 'marketplace', 'packages')
const USER_DATA = mkdtempSync(join(tmpdir(), 'vyotiq-skills-smoke-'))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? USER_DATA : tmpdir()),
    getAppPath: () => REPO,
    isPackaged: false
  }
}))

function listSkillDirs(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      if (!st.isDirectory()) continue
      if (existsSync(join(abs, 'SKILL.md')) || existsSync(join(abs, 'skill.md'))) {
        out.push(abs)
      }
      walk(abs)
    }
  }
  walk(root)
  return out
}

describe('skills smoke (bundled + isolated marketplace)', () => {
  let skillDirs: string[] = []

  beforeAll(() => {
    mkdirSync(join(USER_DATA, 'marketplace', 'packages'), { recursive: true })
    skillDirs = listSkillDirs(PACKAGES)
  })

  afterAll(() => {
    rmSync(USER_DATA, { recursive: true, force: true })
  })

  beforeEach(() => {
    mkdirSync(join(USER_DATA, 'marketplace', 'packages'), { recursive: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('finds all 18 bundled skill directories with SKILL.md', () => {
    expect(skillDirs.length).toBe(18)
    for (const dir of skillDirs) {
      expect(existsSync(join(dir, 'SKILL.md')), dir).toBe(true)
    }
  })

  it('parses every bundled SKILL.md with agentskills frontmatter', async () => {
    const { parseSkillFrontmatter, skillPackageVersion } = await import('@main/agent/skills/parse')
    for (const dir of skillDirs) {
      const raw = readFileSync(join(dir, 'SKILL.md'), 'utf8')
      const parsed = parseSkillFrontmatter(raw)
      expect(parsed.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      expect(parsed.description.length).toBeGreaterThan(20)
      expect(parsed.description.length).toBeLessThanOrEqual(1024)
      expect(skillPackageVersion(parsed)).toBeTruthy()
      expect(parsed.body.trim().length).toBeGreaterThan(40)
      expect(parsed.body).toMatch(/## Instructions/i)
    }
  })

  it('detectPackageAt treats each standalone skill package as kind skill', async () => {
    const { detectPackageAt } = await import('@main/marketplace/install')
    const standalone = [
      'accessibility',
      'api-design',
      'code-review',
      'commit-message',
      'debug',
      'docs',
      'frontend-design',
      'pr-description',
      'refactor',
      'security-review',
      'test-writing'
    ]
    for (const id of standalone) {
      const detected = detectPackageAt(join(PACKAGES, id))
      expect(detected.kind).toBe('skill')
      expect(detected.id).toBeTruthy()
      expect(detected.version).toBeTruthy()
    }
  })

  it('buildSkillsSection is metadata-only, points at Skill tool, and dedupes names', async () => {
    const { parseSkillFrontmatter } = await import('@main/agent/skills/parse')
    const { buildSkillsSection } = await import('@main/agent/skills')
    const skills = skillDirs.map((dir, i) => {
      const parsed = parseSkillFrontmatter(readFileSync(join(dir, 'SKILL.md'), 'utf8'))
      return {
        id: `smoke-${i}`,
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        root: dir,
        skillPath: join(dir, 'SKILL.md'),
        source: 'skill' as const
      }
    })
    // Duplicate plugin copy of the first skill should not appear twice.
    const withDup = [
      ...skills,
      {
        ...skills[0]!,
        id: 'plugin-dup',
        source: 'plugin' as const,
        description: 'duplicate plugin copy'
      }
    ]
    const section = buildSkillsSection(withDup)
    expect(section).toContain('## Available skills')
    expect(section).toContain('`Skill` tool')
    expect(section).toContain('code-review')
    expect(section).not.toMatch(/## Instructions/)
    expect(section).not.toContain('duplicate plugin copy')
    const nameHits = section.match(new RegExp(`\\*\\*${skills[0]!.name}\\*\\*`, 'g'))
    expect(nameHits?.length).toBe(1)
  })

  it('Skill tool loads real code-review body and blocks escape', async () => {
    const skillRoot = join(PACKAGES, 'code-review')
    const skillsMod = await import('@main/agent/skills')
    const parsed = (await import('@main/agent/skills/parse')).parseSkillFrontmatter(
      readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')
    )
    vi.spyOn(skillsMod, 'findEnabledSkillByName').mockReturnValue({
      id: 'code-review',
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      root: skillRoot,
      skillPath: join(skillRoot, 'SKILL.md'),
      source: 'skill'
    })
    const { toolSkill } = await import('@main/agent/tools/skill')
    const loaded = toolSkill(USER_DATA, 'code-review')
    expect(loaded).toContain('Summarize what changed')
    expect(loaded).toMatch(/skill:\s*code-review/i)
    expect(() => toolSkill(USER_DATA, 'code-review', '../settings.json')).toThrow()
  })

  it('TOOL_REGISTRY exposes Skill as a builtin', async () => {
    const { AGENT_TOOLS } = await import('@main/agent/schemas/tools')
    const { BUILTIN_TOOL_NAMES } = await import('@main/agent/tools')
    expect([...BUILTIN_TOOL_NAMES]).toContain('Skill')
    const skill = AGENT_TOOLS.find((t) => t.name === 'Skill')
    expect(skill).toBeTruthy()
    expect(skill!.description.toLowerCase()).toMatch(/skill/)
  })

  it('installs code-review into temp marketplace and loadEnabledSkills finds it', async () => {
    const { writeMarketplaceIndex } = await import('@main/marketplace/indexStore')
    writeMarketplaceIndex({ schemaVersion: 1, items: [] })

    const { installMarketplacePackage } = await import('@main/marketplace/install')
    const skillsMod = await import('@main/agent/skills')
    vi.spyOn(skillsMod, 'findEnabledSkillByName').mockRestore()

    const result = await installMarketplacePackage({
      source: 'bundled',
      target: 'code-review'
    })
    expect(result.item.kind).toBe('skill')
    expect(result.item.id).toBe('code-review')
    expect(result.item.enabled).toBe(true)

    const enabled = skillsMod.loadEnabledSkills()
    const review = enabled.find((s) => s.name === 'code-review')
    expect(review).toBeTruthy()
    expect(existsSync(review!.skillPath)).toBe(true)

    const section = skillsMod.buildSkillsSection(enabled)
    expect(section).toContain('code-review')
    expect(section).toContain('`Skill` tool')
    expect(section).not.toMatch(/## Instructions/)

    const found = skillsMod.findEnabledSkillByName('code-review')
    expect(found?.name).toBe('code-review')

    const body = (await import('@main/agent/tools/skill')).toolSkill(USER_DATA, 'code-review')
    expect(body).toContain('Summarize what changed')
  })
})
