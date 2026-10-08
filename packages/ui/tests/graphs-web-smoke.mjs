/** Real dsh profile, Remote, durable cards, scoped tools, and Flow dispatch with a keyless model. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const [url, topScreenshot, insideScreenshot] = process.argv.slice(2)
assert.ok(url, 'Pass the authenticated URL of a profile with fixtures/graphs.patch.yml')
const root = await mkdtemp(join(tmpdir(), 'graphs-browser-'))
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1760, height: 1400 }, locale: 'en-US', colorScheme: 'dark' })
let original
const errors = []
page.on('pageerror', error => errors.push(error.message))
try {
  await page.addLocatorHandler(page.getByRole('button', { name: /^(Continue|继续)$/ }), button => button.click())
  await page.addLocatorHandler(page.getByRole('button', { name: 'Configure later', exact: true }), button => button.click())
  await page.goto(url, { waitUntil: 'load' })
  await page.getByRole('button', { name: 'Graphs', exact: true }).click({ timeout: 60000 })
  await page.getByRole('button', { name: 'Billing', exact: true }).click()
  await page.getByRole('button', { name: 'Edit graph', exact: true }).click()
  const field = name => page.getByRole('textbox', { name, exact: true })
  original = Object.fromEntries(await Promise.all(['Provider', 'Model', 'Memory folder', 'Agent block JSON (Flow scope)'].map(async name => [name, await field(name).inputValue()])))
  await field('Provider').fill('graph-fixture')
  await field('Model').fill('scripted')
  await field('Memory folder').fill(join(root, 'memory'))
  const node = JSON.parse(original['Agent block JSON (Flow scope)'])
  await field('Agent block JSON (Flow scope)').fill(JSON.stringify({ ...node, provider: 'graph-fixture', model: 'scripted' }))
  await page.getByRole('button', { name: 'Save graph', exact: true }).click()
  await page.getByRole('button', { name: 'Top level · Jev', exact: true }).click()
  const suffix = Date.now().toString(36)
  const title = `Explain the invoice · ${suffix}`
  await field('New card').fill(title)
  await field('What needs doing?').fill('Explain the additional service day without changing files.')
  await field('Workspace path').fill(root)
  await page.getByRole('button', { name: 'Send to inbox', exact: true }).click()
  const done = page.getByRole('region', { name: 'Done', exact: true })
  await done.getByRole('button', { name: title, exact: true }).waitFor({ timeout: 60000 })
  assert.equal(await readFile(join(root, 'memory/browser-check.md'), 'utf8'), 'Invoice explanation verified against the local workspace.\n')
  const blocked = `Deploy production · ${suffix}`
  await field('New card').fill(blocked)
  await page.getByRole('button', { name: 'Send to inbox', exact: true }).click()
  await page.getByRole('region', { name: 'Needs you', exact: true }).getByRole('button', { name: blocked, exact: true }).waitFor()
  await page.getByRole('button', { name: 'Routing log', exact: true }).click()
  await page.getByText('95%', { exact: true }).first().waitFor()
  if (topScreenshot) await page.screenshot({ path: topScreenshot })
  await page.getByRole('button', { name: 'Billing', exact: true }).click()
  await done.getByRole('button', { name: title, exact: true }).click()
  await page.getByText('Invoice explanation verified against the local workspace.', { exact: false }).waitFor()
  await page.getByText('Invoice explained from the local read-only billing node.', { exact: true }).first().waitFor()
  assert.match(await page.getByRole('complementary').innerText(), /dispatch[\s\S]*Run [\w-]+/)
  if (insideScreenshot) await page.screenshot({ path: insideScreenshot })
  await page.emulateMedia({ colorScheme: 'light' })
  if (insideScreenshot) await page.screenshot({ path: insideScreenshot.replace(/\.png$/, '-light.png') })
  await page.setViewportSize({ width: 760, height: 1100 })
  assert.equal(await page.getByRole('main').evaluate(node => node.scrollWidth <= node.clientWidth), true)
  assert.deepEqual(errors, [])
  console.log('PASS: real Graphs routing/fallback, scoped lead memory, Flow dispatch, production rule, board, timeline, both themes, narrow layout; no external model calls.')
} catch (error) {
  console.error('Page alerts:', await page.getByRole('alert').allTextContents())
  console.error('Page dialogs:', await page.getByRole('dialog').allTextContents())
  console.error('Browser errors:', errors)
  throw error
} finally {
  try {
    if (original) {
      await page.getByRole('button', { name: 'Edit graph', exact: true }).click()
      for (const [name, value] of Object.entries(original)) await page.getByRole('textbox', { name, exact: true }).fill(value)
      await page.getByRole('button', { name: 'Save graph', exact: true }).click()
      await page.getByRole('button', { name: 'Edit graph', exact: true }).waitFor()
    }
  } finally { await browser.close(); await rm(root, { recursive: true, force: true }) }
}
