import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { seedRunsInUserData } from './helpers/seedWorkspace'

let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-pane-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp()

  // Seed before addWorkspace so the first listRuns (and its cache) sees the runs.
  seedRunsInUserData(launched.userDataDir, workspacePath, [
    { runId: 'run-alpha', goal: 'Pane Session Alpha', updatedAt: '2026-08-08T00:00:10.000Z' },
    { runId: 'run-beta', goal: 'Pane Session Beta', updatedAt: '2026-08-08T00:00:20.000Z' }
  ])

  const addRes = await launched.window.evaluate(async (path) => {
    return window.vyotiq.addWorkspace(path)
  }, workspacePath)
  expect(addRes.ok).toBe(true)
  if (!addRes.ok) throw new Error(addRes.error)
  const openPath = addRes.data.activePath
  expect(openPath).toBeTruthy()

  const listed = await launched.window.evaluate(async (path) => {
    return window.vyotiq.listRuns(path)
  }, openPath)
  expect(listed.ok).toBe(true)
  if (!listed.ok) throw new Error(listed.error)
  expect(listed.data.runs.map((r) => r.goal)).toEqual(
    expect.arrayContaining(['Pane Session Alpha', 'Pane Session Beta'])
  )

  workspacePath = openPath
  await launched.window.evaluate(() => {
    localStorage.removeItem('vyotiq.chatPaneLayout')
  })
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
  await expect(launched.window.locator('body')).toBeVisible({ timeout: 30_000 })
})

test.afterAll(async () => {
  const videoPath = launched?.window.video()
    ? await launched.window.video()?.path().catch(() => null)
    : null
  if (launched) await closeApp(launched)
  if (videoPath) {
    console.log(`[gui-e2e] chatPane video: ${videoPath}`)
  }
  try {
    rmSync(workspacePath, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

test('drag sidebar session onto right third splits into two panes', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /expand sidebar/i })
  if (await expand.isVisible().catch(() => false)) {
    await expand.click()
  }

  const alpha = window.getByTitle('Pane Session Alpha').first()
  const beta = window.getByTitle('Pane Session Beta').first()
  await expect(alpha).toBeVisible({ timeout: 20_000 })
  await expect(beta).toBeVisible({ timeout: 20_000 })

  await alpha.click()
  await expect(window.locator('[data-chat-pane-host]')).toBeVisible({ timeout: 15_000 })
  await expect(window.locator('[data-chat-pane]')).toHaveCount(1)

  const host = window.locator('[data-chat-pane-host]')
  const box = await host.boundingBox()
  expect(box).toBeTruthy()

  await beta.dragTo(host, {
    targetPosition: {
      x: Math.floor((box?.width ?? 600) * 0.85),
      y: Math.floor((box?.height ?? 400) * 0.5)
    }
  })

  await expect(window.locator('[data-chat-pane]')).toHaveCount(2, { timeout: 15_000 })
  await expect(window.locator('[data-chat-pane-focused="1"]')).toHaveCount(1)

  // Clicking an already-open session focuses its pane; does not add a third.
  await alpha.click()
  await expect(window.locator('[data-chat-pane]')).toHaveCount(2)
  await expect(window.locator('[data-chat-pane-focused="1"]')).toHaveCount(1)

  const betaPane = window.locator('[data-chat-pane]').nth(1)
  await betaPane.hover()
  await window.getByRole('button', { name: /Close Pane Session Beta/i }).click()
  await expect(window.locator('[data-chat-pane]')).toHaveCount(1, { timeout: 10_000 })
})
