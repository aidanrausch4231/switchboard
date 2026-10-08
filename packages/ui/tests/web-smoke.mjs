/** Keyless browser check against the documented, already-running Switchboard profile. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const [url, screenshot] = process.argv.slice(2)
assert.ok(url, 'Pass the authenticated URL printed by dsh --profile switchboard')
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const expected = new URL('./expected/page.aria.txt', import.meta.url)
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US', colorScheme: 'dark' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addLocatorHandler(page.getByRole('button', { name: /^(Continue|继续)$/ }), button => button.click())
  await page.addLocatorHandler(page.getByRole('button', { name: 'Configure later', exact: true }), button => button.click())
  await page.goto(url, { waitUntil: 'load' })
  await page.getByRole('button', { name: 'Switchboard', exact: true }).waitFor({ timeout: 60000 })
  await page.getByRole('button', { name: 'Switchboard', exact: true }).click()
  await page.getByText('Connected', { exact: true }).waitFor()
  const main = page.getByRole('main')
  await main.getByRole('group', { name: 'ChatGPT', exact: true }).waitFor()
  const ping = JSON.parse(await main.locator('pre').innerText())
  assert.equal(ping.ok, true)
  assert.equal(ping.version, version)
  assert.equal(new Date(ping.time).toISOString(), ping.time)
  const actual = (await main.ariaSnapshot()).replaceAll(ping.time, '<HOST_TIME>').replaceAll(version, '<VERSION>') + '\n'
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, actual)
  else {
    let snapshot = await readFile(expected, 'utf8')
    if (process.env.DSH_EXPECT_STOCK === '1') snapshot = snapshot.replace('      - button "Sign in"\n', '      - button "Sign in" [disabled]\n      - status: ChatGPT needs pi-ai >= 1.0. Use the patched dsh runtime to sign in.\n')
    assert.equal(actual, snapshot)
  }
  for (const [name, heading] of [
    ['Flows', 'Saved flows'], ['Automations', 'Automations'], ['Graphs', 'Graphs'],
    ['Council', 'Council'], ['Voice', 'Voice'],
  ]) {
    await main.getByRole('button', { name, exact: true }).click()
    await page.getByRole('heading', { name: heading, exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name, exact: true }).getAttribute('aria-current'), 'page')
    await page.getByRole('button', { name: 'Switchboard', exact: true }).click()
    await page.getByText('Connected', { exact: true }).waitFor()
    await main.getByRole('group', { name: 'ChatGPT', exact: true }).waitFor()
  }
  assert.deepEqual(errors, [])
  if (screenshot) {
    await page.screenshot({ path: screenshot })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-light.png') })
  }
  console.log('Switchboard: workspace navigation, live Host ping, and page expectation passed.')
} finally {
  await browser.close()
}
