/** Keyless Voice-page expectation against a running dsh Switchboard profile. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const [url, screenshot] = process.argv.slice(2)
assert.ok(url, 'Pass the authenticated dsh URL')
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', colorScheme: 'dark' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addLocatorHandler(page.getByRole('button', { name: /^(Continue|继续)$/ }), button => button.click())
  await page.addLocatorHandler(page.getByRole('button', { name: 'Configure later', exact: true }), button => button.click())
  await page.goto(url)
  await page.getByRole('textbox', { name: 'Search session names' }).fill('Switchboard chat fixture', { timeout: 60000 })
  await page.getByRole('treeitem', { name: /Switchboard chat fixture/ }).first().click({ timeout: 60000 })
  await page.getByRole('button', { name: 'Voice', exact: true }).click()
  const main = page.getByRole('region', { name: 'Voice', exact: true })
  await main.getByText('OpenAI key present on Host: No', { exact: true }).waitFor()
  assert.equal(await main.getByRole('combobox', { name: 'Speech to text' }).inputValue(), 'browser')
  assert.equal(await main.getByRole('combobox', { name: 'Speak final replies' }).inputValue(), 'off')
  await main.getByRole('combobox', { name: 'Speech to text' }).selectOption('openai')
  assert.equal(await main.getByRole('combobox', { name: 'Speech to text' }).inputValue(), 'openai')
  await main.getByRole('combobox', { name: 'Speech to text' }).selectOption('browser')
  const expected = new URL('./expected/voice.aria.txt', import.meta.url)
  const actual = `${await main.ariaSnapshot()}\n`
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, actual)
  else assert.equal(actual, await readFile(expected, 'utf8'))
  if (screenshot) {
    await page.screenshot({ path: screenshot })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-light.png') })
  }
  await page.getByRole('treeitem', { name: /Switchboard chat fixture/ }).first().click()
  const composer = page.getByRole('region', { name: 'Voice', exact: true })
  await composer.getByRole('button', { name: 'Hold to talk' }).waitFor()
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-composer.png') })
  assert.deepEqual(errors, [])
  console.log('Voice: real Host readiness, settings, and page expectation passed.')
} finally { await browser.close() }
