import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { seedWorkspacesRegistry } from './helpers/seedWorkspace'

let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-files-gui-'))
  mkdirSync(join(workspacePath, 'src'), { recursive: true })
  writeFileSync(join(workspacePath, 'src', 'note.ts'), 'export const value = 1\n', 'utf8')
  writeFileSync(join(workspacePath, '.hidden.txt'), 'hidden\n', 'utf8')
  launched = await launchApp({
    preLaunchSeed: (userDataDir) => seedWorkspacesRegistry(userDataDir, workspacePath, null)
  })
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  if (workspacePath) rmSync(workspacePath, { recursive: true, force: true })
})

test('opens Files, edits a real workspace file, and saves it', async () => {
  const { window } = launched
  const filesButton = window.getByRole('button', { name: /Show files panel/i })
  await expect(filesButton).toBeVisible({ timeout: 20_000 })
  await filesButton.click()

  await expect(window.getByRole('tabpanel', { name: 'Files' })).toBeVisible()
  await expect(window.getByText('src')).toBeVisible()
  await window.getByText('src').click()
  await expect(window.getByText('note.ts')).toBeVisible()
  await window.getByText('note.ts').click()
  await expect(window.getByRole('tab', { name: /note\.ts/i })).toBeVisible()

  await window.getByRole('button', { name: 'Editor actions' }).click()
  await expect(window.getByRole('menu', { name: 'Editor actions' })).toBeVisible()
  await expect(window.getByRole('menuitem', { name: 'Diff View' })).toBeVisible()
  await expect(window.getByRole('menuitemcheckbox', { name: 'Auto Save' })).toBeVisible()
  await window.keyboard.press('Escape')

  const editor = window.locator('[data-code-editor] .cm-content')
  await expect(editor).toBeVisible()
  await editor.click()
  await window.keyboard.press('Control+A')
  await window.keyboard.type('export const value = 2\n')

  await expect
    .poll(async () => {
      return readFileSync(join(workspacePath, 'src', 'note.ts'), 'utf8')
    }, { timeout: 10_000 })
    .toBe('export const value = 2\n')

  const treeNote = window.locator('[role="treeitem"]').filter({ hasText: 'note.ts' })
  await treeNote.click({ button: 'right' })
  await expect(window.getByRole('menu', { name: 'Files actions' })).toBeVisible()
  await expect(window.getByRole('menuitem', { name: 'Copy relative path' })).toBeVisible()
  await window.keyboard.press('Escape')
})
