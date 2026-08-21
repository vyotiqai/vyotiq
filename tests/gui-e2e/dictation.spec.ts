import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'

const FIXTURE_TRANSCRIPT = 'E2E dictation transcript.'

let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-dictation-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({ e2eFixture: true })

  await launched.window.addInitScript(() => {
    class FakeMediaRecorder {
      static isTypeSupported(type: string): boolean {
        return type.startsWith('audio/webm')
      }
      state: 'inactive' | 'recording' = 'inactive'
      ondataavailable: ((ev: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      onerror: (() => void) | null = null
      start(): void {
        this.state = 'recording'
      }
      stop(): void {
        this.state = 'inactive'
        this.ondataavailable?.({
          data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' })
        })
        this.onstop?.()
      }
    }
    // @ts-expect-error stub for e2e
    window.MediaRecorder = FakeMediaRecorder
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop: () => undefined }]
        })
      }
    })
  })

  const addRes = await launched.window.evaluate(async (path) => {
    return window.vyotiq.addWorkspace(path)
  }, workspacePath)
  expect(addRes.ok).toBe(true)
  if (!addRes.ok) throw new Error(addRes.error)

  workspacePath = addRes.data.activePath
  await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({ toolApprovalOnboardingDone: true })
    await window.vyotiq.setSecret('openai', 'sk-e2e-dictation-fixture')
    localStorage.removeItem('vyotiq.chatPaneLayout')
    localStorage.removeItem('vyotiq.rightPanel')
    localStorage.removeItem('vyotiq.browserPanelOpen')
  })
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
  await expect(launched.window.locator('body')).toBeVisible({ timeout: 30_000 })
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  try {
    rmSync(workspacePath, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

test('Mic stop inserts fixture transcript into Message', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /expand sidebar/i })
  if (await expand.isVisible().catch(() => false)) {
    await expand.click()
  }

  const composer = window.getByRole('textbox', { name: 'Message' })
  await expect(composer).toBeVisible({ timeout: 20_000 })

  const dictate = window.getByRole('button', { name: /^Dictate$/i })
  await expect(dictate).toBeVisible()
  await dictate.click()

  const stopDictate = window.getByRole('button', { name: /^Stop dictation$/i })
  await expect(stopDictate).toBeVisible()
  await stopDictate.click()

  await expect(composer).toContainText(FIXTURE_TRANSCRIPT, { timeout: 15_000 })
})
