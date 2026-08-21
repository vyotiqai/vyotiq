import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { APPEARANCE_LOCAL_STORAGE_KEY } from '../../src/shared/appearance'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { seedAppSettings } from './helpers/seedWorkspace'
import {
  leaveSettingsIfOpen,
  openAppearanceSection,
  openSettings,
  readAppearanceBootCache,
  readRootAppearance,
  resetAppearanceSettings,
  selectSettingsMenu
} from './helpers/settings'

let launched: LaunchedApp

test.beforeAll(async () => {
  launched = await launchApp()
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
})

test.beforeEach(async () => {
  const { window } = launched
  await leaveSettingsIfOpen(window)
  await resetAppearanceSettings(window)
})

test('settings nav opens appearance section with all controls', async () => {
  const { window } = launched
  await openAppearanceSection(window)

  await expect(window.getByRole('button', { name: /^theme$/i })).toBeVisible()
  await expect(window.getByRole('button', { name: /^text size$/i })).toBeVisible()
  await expect(window.getByRole('button', { name: /^ui density$/i })).toBeVisible()
  await expect(window.getByRole('button', { name: /^accent color$/i })).toBeVisible()
})

test('settings search navigates to appearance accent field', async () => {
  const { window } = launched
  await openSettings(window)

  const search = window.getByRole('textbox', { name: /search settings/i })
  await search.fill('accent')
  await search.press('Enter')

  await expect(window.getByText('Accent color')).toBeVisible({ timeout: 10_000 })
  await expect(window.getByRole('button', { name: /^accent color$/i })).toBeVisible()
})

test('theme menu updates DOM, boot cache, and persisted settings', async () => {
  const { window, userDataDir } = launched
  await openAppearanceSection(window)
  await selectSettingsMenu(window, /^theme$/i, /^dark$/i)

  await expect
    .poll(async () => readRootAppearance(window))
    .toMatchObject({ theme: 'dark' })

  const cache = await readAppearanceBootCache(window)
  expect(cache?.theme).toBe('dark')
  expect(cache?.resolvedTheme).toBe('dark')

  await expect
    .poll(async () => {
      const res = await window.evaluate(async () => window.vyotiq.getSettings())
      return res.ok ? res.data.theme : null
    })
    .toBe('dark')

  const onDisk = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')) as {
    theme?: string
  }
  expect(onDisk.theme).toBe('dark')
})

test('font scale and density menus update document attributes and CSS tokens', async () => {
  const { window } = launched
  await openAppearanceSection(window)

  await selectSettingsMenu(window, /^text size$/i, /^large$/i)
  await selectSettingsMenu(window, /^ui density$/i, /^compact$/i)

  await expect
    .poll(async () => readRootAppearance(window))
    .toMatchObject({ fontScale: 'large', density: 'compact' })

  const tokens = await window.evaluate(() => {
    const style = getComputedStyle(document.documentElement)
    return {
      fontScale: style.getPropertyValue('--vy-font-scale').trim(),
      densityScale: style.getPropertyValue('--vy-density-scale').trim()
    }
  })
  expect(Number.parseFloat(tokens.fontScale)).toBeCloseTo(1.08, 2)
  expect(Number.parseFloat(tokens.densityScale)).toBeCloseTo(0.9, 2)

  const settings = await window.evaluate(async () => {
    const res = await window.vyotiq.getSettings()
    return res.ok ? res.data : null
  })
  expect(settings?.fontScale).toBe('large')
  expect(settings?.uiDensity).toBe('compact')
})

test('accent menu updates data-accent and CSS accent token', async () => {
  const { window } = launched
  await openAppearanceSection(window)
  await selectSettingsMenu(window, /^theme$/i, /^light$/i)
  await selectSettingsMenu(window, /^accent color$/i, /^violet$/i)

  await expect
    .poll(async () => readRootAppearance(window))
    .toMatchObject({ theme: 'light', accent: 'violet' })

  const accent = await window.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--vy-accent').trim()
  )
  expect(accent.toLowerCase()).toBe('#6d28d9')

  const settings = await window.evaluate(async () => {
    const res = await window.vyotiq.getSettings()
    return res.ok ? res.data : null
  })
  expect(settings?.accentPreset).toBe('violet')
})

test('appearance boot cache survives reload before React hydrates', async () => {
  const { window } = launched
  await openAppearanceSection(window)
  await selectSettingsMenu(window, /^theme$/i, /^light$/i)
  await selectSettingsMenu(window, /^text size$/i, /^small$/i)
  await selectSettingsMenu(window, /^ui density$/i, /^comfortable$/i)
  await selectSettingsMenu(window, /^accent color$/i, /^green$/i)

  await expect
    .poll(async () => readAppearanceBootCache(window))
    .toMatchObject({
      theme: 'light',
      resolvedTheme: 'light',
      fontScale: 'small',
      uiDensity: 'comfortable',
      accentPreset: 'green'
    })

  await window.reload()
  await window.locator('body').waitFor({ state: 'attached', timeout: 45_000 })

  await expect
    .poll(async () => readRootAppearance(window))
    .toMatchObject({
      theme: 'light',
      fontScale: 'small',
      density: 'comfortable',
      accent: 'green'
    })

  const settings = await window.evaluate(async () => {
    const res = await window.vyotiq.getSettings()
    return res.ok ? res.data : null
  })
  expect(settings).toMatchObject({
    theme: 'light',
    fontScale: 'small',
    uiDensity: 'comfortable',
    accentPreset: 'green'
  })
})

test.describe('seeded appearance on boot', () => {
  let seeded: LaunchedApp

  test.afterAll(async () => {
    if (seeded) await closeApp(seeded)
  })

  test('applies seeded settings.json appearance on first paint', async () => {
    seeded = await launchApp({
      preLaunchSeed: (userDataDir) => {
        seedAppSettings(userDataDir, {
          theme: 'dark',
          fontScale: 'large',
          uiDensity: 'comfortable',
          accentPreset: 'blue'
        })
      }
    })

    await expect
      .poll(async () => readRootAppearance(seeded.window))
      .toMatchObject({
        theme: 'dark',
        fontScale: 'large',
        density: 'comfortable',
        accent: 'blue'
      })

    const cache = await readAppearanceBootCache(seeded.window)
    expect(cache).toMatchObject({
      theme: 'dark',
      resolvedTheme: 'dark',
      fontScale: 'large',
      uiDensity: 'comfortable',
      accentPreset: 'blue'
    })

    const onDisk = JSON.parse(readFileSync(join(seeded.userDataDir, 'settings.json'), 'utf8')) as {
      theme?: string
      fontScale?: string
      uiDensity?: string
      accentPreset?: string
    }
    expect(onDisk).toMatchObject({
      theme: 'dark',
      fontScale: 'large',
      uiDensity: 'comfortable',
      accentPreset: 'blue'
    })
  })
})

test('corrupt appearance boot cache does not break startup', async () => {
  const { window } = launched
  await window.evaluate(
    ([key, payload]) => {
      localStorage.setItem(key, payload)
    },
    [APPEARANCE_LOCAL_STORAGE_KEY, '{not-json'] as const
  )

  await window.reload()
  await window.locator('body').waitFor({ state: 'attached', timeout: 45_000 })

  await expect(window.getByRole('button', { name: /^settings$/i })).toBeVisible({
    timeout: 15_000
  })

  const attrs = await readRootAppearance(window)
  expect(attrs.fontScale).toBe('default')
  expect(attrs.density).toBe('default')
  expect(attrs.accent).toBe('neutral')
})
