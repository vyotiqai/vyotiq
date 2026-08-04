import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'

let launched: LaunchedApp

test.beforeAll(async () => {
  launched = await launchApp()
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
})

/** Reset shell chrome between tests without relaunching Electron. */
test.beforeEach(async () => {
  const { window } = launched
  await window.keyboard.press('Escape')
  // Blur any editable so app chords are not skipped
  await window.evaluate(() => {
    const ae = document.activeElement as HTMLElement | null
    ae?.blur?.()
  })
  // Leave settings / marketplace if open
  const back = window.getByRole('button', { name: /^back$/i })
  if (await back.isVisible().catch(() => false)) {
    await back.click()
  }
  // Ensure desktop sidebar is expanded
  const expand = window.getByRole('button', { name: /expand sidebar/i })
  if (await expand.isVisible().catch(() => false)) {
    await expand.click()
  }
})

test('app opens a main window', async () => {
  const { window } = launched
  await expect(window.locator('body')).toBeVisible()
  await expect(window.getByRole('button', { name: /^settings$/i })).toBeVisible()
})

test('Ctrl/Cmd+B toggles the sidebar', async () => {
  const { window } = launched
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

  const collapse = window.getByRole('button', { name: /collapse sidebar/i })
  await expect(collapse).toBeVisible({ timeout: 10_000 })
  await window.keyboard.press(`${mod}+B`)
  await expect(window.getByRole('button', { name: /expand sidebar/i })).toBeVisible()
  await window.keyboard.press(`${mod}+B`)
  await expect(window.getByRole('button', { name: /collapse sidebar/i })).toBeVisible()
})

test('Ctrl/Cmd+, opens settings', async () => {
  const { window } = launched
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await window.keyboard.press(`${mod}+Comma`)
  await expect(
    window.getByRole('button', { name: /general/i }).or(window.getByText(/^general$/i)).first()
  ).toBeVisible({ timeout: 10_000 })
})

test('hovering Settings IconButton shows custom tooltip; Esc dismisses', async () => {
  const { window } = launched
  const settings = window.getByRole('button', { name: /^settings$/i }).first()
  await settings.hover()
  const tip = window.locator('[role="tooltip"]')
  await expect(tip).toBeVisible({ timeout: 3_000 })
  await expect(tip).toContainText(/settings/i)
  await window.keyboard.press('Escape')
  await expect(tip).toHaveCount(0)
})
