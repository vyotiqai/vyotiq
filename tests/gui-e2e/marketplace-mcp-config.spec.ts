import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { leaveSettingsIfOpen, openSettings } from './helpers/settings'

let launched: LaunchedApp

test.beforeAll(async () => {
  launched = await launchApp()
}, { timeout: 90_000 })

test.afterAll(async () => {
  if (launched) await closeApp(launched)
})

test.beforeEach(async () => {
  const { window } = launched
  await leaveSettingsIfOpen(window)
})

test('marketplace opens from the sidebar with browse controls', async () => {
  const { window } = launched

  await window.getByRole('button', { name: 'Marketplace' }).click()

  // Section header + tab list render.
  await expect(window.getByRole('tablist', { name: 'Marketplace sections' })).toBeVisible({
    timeout: 15_000
  })
  await expect(window.getByRole('tab', { name: 'Browse' })).toBeVisible()
  await expect(window.getByRole('tab', { name: 'Manage' })).toBeVisible()
})

test('marketplace browse exposes search and kind filter', async () => {
  const { window } = launched

  await window.getByRole('button', { name: 'Marketplace' }).click()
  const search = window.getByRole('textbox', { name: 'Search marketplace' })
  await expect(search).toBeVisible({ timeout: 15_000 })

  await search.fill('whisper')
  await expect(search).toHaveValue('whisper')
  await search.fill('')

  await expect(window.getByRole('button', { name: /filter by kind/i })).toBeVisible()
})

test('manage tab reveals registry settings panel', async () => {
  const { window } = launched

  await window.getByRole('button', { name: 'Marketplace' }).click()
  await window.getByRole('tab', { name: 'Manage' }).click()

  const registry = window.getByRole('region', { name: 'Package registry' })
  await expect(registry).toBeVisible({ timeout: 10_000 })
  await expect(registry.getByText('Registry URL')).toBeVisible()
  await expect(registry.getByPlaceholder(/registry\.example\.com/i)).toBeVisible()
  await expect(window.getByRole('tablist', { name: 'Manage marketplace' })).toBeVisible()
})

test('integrations settings expose GitHub OAuth client id wiring', async () => {
  const { window } = launched

  await openSettings(window)
  await window.getByRole('button', { name: /^integrations$/i }).click()

  const clientId = window.getByRole('textbox', { name: 'GitHub client ID' })
  await expect(clientId).toBeVisible({ timeout: 10_000 })

  // Persist through the real settings path, then confirm the bridge round-trips it.
  await clientId.fill('e2e-test-client-id')
  await clientId.press('Tab')
  await expect
    .poll(
      async () =>
        window.evaluate(() =>
          window.vyotiq
            ?.getSettings?.()
            .then((res) => (res.ok ? (res.data.githubClientId ?? null) : null))
        ),
      { timeout: 10_000 }
    )
    .toBe('e2e-test-client-id')
})
