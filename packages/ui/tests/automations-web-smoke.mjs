/** Keyless browser evidence against a dsh profile with the opt-in automation-web Host fixture. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const [url, screenshot, mode] = process.argv.slice(2)
assert.ok(url && screenshot, 'Pass the authenticated local profile URL and screenshot path')
assert.ok(mode === undefined || mode === 'existing', 'Use existing to verify the previously created fixture without new runs')
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', colorScheme: 'dark' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url, { waitUntil: 'load' })
  await page.getByRole('button', { name: 'Automations', exact: true }).waitFor({ timeout: 60000 })
  const preview = page.getByRole('dialog', { name: 'Preview Notice' })
  await page.addLocatorHandler(preview, async () => { await preview.getByRole('button', { name: 'Continue', exact: true }).click() })
  const later = page.getByRole('button', { name: 'Configure later', exact: true })
  await page.addLocatorHandler(later, async () => { await later.click() })
  await page.getByRole('button', { name: 'Automations', exact: true }).click()
  const main = page.getByRole('main')
  const row = main.getByRole('button', { name: /^Company research automation/ }).last()
  if (mode === 'existing') await row.click()
  else {
    await page.getByRole('button', { name: 'New automation', exact: true }).click()
    const drawer = page.getByRole('dialog')
    await drawer.getByLabel('Name', { exact: true }).fill('Company research automation')
    await drawer.getByRole('combobox', { name: 'Flow', exact: true }).selectOption('automation-example-company-research')
    await drawer.getByRole('textbox', { name: 'Inputs (JSON)', exact: true }).fill('{"company":"Switchboard"}')
    await drawer.getByRole('combobox', { name: 'Schedule', exact: true }).selectOption('manual')
    await drawer.getByRole('button', { name: 'Save automation', exact: true }).click()
    await drawer.waitFor({ state: 'hidden' })
    for (const [index, state] of ['Succeeded', 'Succeeded', 'Failed'].entries()) {
      await main.getByRole('button', { name: 'Run now', exact: true }).click()
      await main.getByRole('listitem').nth(index).waitFor({ timeout: 60000 })
      await page.waitForFunction(({ text, state }) => [...document.querySelectorAll('main button')].some(button => button.textContent?.startsWith(text) && button.textContent.endsWith(state)), { text: 'Company research automation', state }, { timeout: 60000 })
      assert.match(await row.innerText(), new RegExp(state))
    }
    await page.getByText('Run started.', { exact: true }).waitFor({ state: 'hidden' })
  }
  await main.getByText(/1 failed runs stopped at research/).waitFor()
  assert.equal(await main.locator('svg circle').count(), 3)
  await main.getByRole('status').filter({ hasText: 'Ready;' }).waitFor()
  assert.equal(await main.getByRole('button', { name: 'Run now', exact: true }).isEnabled(), true)
  await main.getByRole('button', { name: 'Edit automation', exact: true }).click()
  const editor = page.getByRole('dialog')
  await editor.getByRole('region', { name: 'Preflight', exact: true }).getByRole('status').waitFor()
  await editor.getByRole('textbox', { name: 'Inputs (JSON)', exact: true }).fill('{"company":false}')
  await editor.getByRole('alert').first().waitFor()
  assert.equal(await editor.getByRole('button', { name: 'Save automation', exact: true }).isDisabled(), true)
  await editor.getByRole('button', { name: 'Close', exact: true }).click()
  await editor.waitFor({ state: 'hidden' })
  assert.deepEqual(errors, [])
  const actual = (await main.ariaSnapshot())
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<TIME>')
    .replace(/\d{1,2}\/\d{1,2}\/\d{4},? \d{1,2}:\d{2}:\d{2} [AP]M/g, '<TIME>')
    .replace(/\b\d+s\b/g, '<DURATION>') + '\n'
  const expected = new URL('./expected/automations.aria.txt', import.meta.url)
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, actual)
  else assert.equal(actual, await readFile(expected, 'utf8'))
  await page.screenshot({ path: screenshot })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.screenshot({ path: screenshot.replace(/\.png$/, '-light.png') })
  console.log(mode === 'existing'
    ? 'Automations: retained live fixture, ARIA expectation, charts, stop callout and both themes passed.'
    : 'Automations: live editor save, three fake-adapter Flow runs, charts, stop callout and both themes passed.')
} finally { await browser.close() }
