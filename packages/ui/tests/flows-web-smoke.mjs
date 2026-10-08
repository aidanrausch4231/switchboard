/** Real dsh/Remote/browser smoke with a test-only model adapter and an isolated workspace. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const runtime = resolve(process.env.DSH_RUNTIME ?? join(root, '../dsh-runtime'))
const output = process.argv[2]
assert.ok(output, 'Pass a screenshot directory')
assert.ok(process.env.DSH_HOME, 'Set DSH_HOME to the keyless Switchboard profile')
const temp = await mkdtemp(join(tmpdir(), 'switchboard-ui-'))
const cwd = join(temp, 'workspace')
const chatTitle = `Switchboard chat fixture ${basename(temp)}`
await mkdir(cwd)
const patch = join(temp, 'smoke.json')
await writeFile(patch, JSON.stringify([
  { id: 'switchboard-core', name: resolve(root, 'packages/core/lib/index.js') },
  { id: 'switchboard-ui', name: resolve(root, 'packages/ui/lib/index.js') },
  { id: 'llm-deepseek', disabled: true },
  { id: 'agent-default-model', config: { provider: 'switchboard-scripted', model: 'scripted' } },
  { id: 'hmr', disabled: true },
  { id: 'open-in-app', disabled: true }, { id: 'ui-open-in-app', disabled: true },
  { insert: [{ id: 'switchboard-scripted', name: fileURLToPath(new URL('./fixtures/scripted.mjs', import.meta.url)) }] },
]))
const child = spawn('pnpm', ['dsh', '--profile', 'switchboard', '--patch', patch, '--patch', fileURLToPath(new URL('./fixtures/pin-browse-picker.overlay.yml', import.meta.url)), '--host', '127.0.0.1', '--port', '0', '--no-open'], {
  cwd: runtime, env: { ...process.env, SWITCHBOARD_SMOKE_CWD: cwd, SWITCHBOARD_SMOKE_TITLE: chatTitle }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
const exited = once(child, 'exit')
let browser
let page
let logs = ''
const collect = chunk => { logs += String(chunk) }
child.stdout.on('data', collect)
child.stderr.on('data', collect)
try {
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('dsh did not announce its URL')) }, 60000)
    const cleanup = () => { clearTimeout(timer); child.stdout.off('data', inspect); child.stderr.off('data', inspect); child.off('exit', failed) }
    const failed = code => { cleanup(); reject(new Error(`dsh exited before readiness: ${code}`)) }
    const inspect = () => {
      const match = logs.match(/http:\/\/127\.0\.0\.1:\d+\S*/)
      if (match) { cleanup(); resolveUrl(match[0].replace(/\x1b\[[\d;]*m/g, '')) }
    }
    child.on('exit', failed); child.stdout.on('data', inspect); child.stderr.on('data', inspect); inspect()
  })
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US', colorScheme: 'dark' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text().replace(/http:\/\/\S+/g, '<LOCAL_URL>')) })
  page.on('response', response => { if (response.status() >= 400) console.error(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`) })
  await page.addLocatorHandler(page.getByRole('button', { name: /^(Continue|继续)$/ }), button => button.click())
  await page.goto(url, { waitUntil: 'load' })
  const later = page.getByRole('button', { name: 'Configure later', exact: true })
  const flows = page.getByRole('button', { name: 'Flows', exact: true })
  await later.or(flows).first().waitFor({ timeout: 60000 })
  if (await later.isVisible()) await later.click()
  await page.getByRole('button', { name: 'Switchboard', exact: true }).click()
  await page.getByText('Connected', { exact: true }).waitFor()
  const main = page.getByRole('main')
  await main.getByRole('group', { name: 'ChatGPT', exact: true }).waitFor()
  const ping = JSON.parse(await main.locator('pre').innerText())
  assert.equal(ping.ok, true)
  const connectivity = (await main.ariaSnapshot()).replaceAll(ping.time, '<HOST_TIME>').replaceAll(ping.version, '<VERSION>') + '\n'
  const pageExpected = new URL('./expected/page.aria.txt', import.meta.url)
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(pageExpected, connectivity)
  else {
    let expected = await readFile(pageExpected, 'utf8')
    if (process.env.DSH_EXPECT_STOCK === '1') expected = expected.replace('      - button "Sign in"\n', '      - button "Sign in" [disabled]\n      - status: ChatGPT needs pi-ai >= 1.0. Use the patched dsh runtime to sign in.\n')
    assert.equal(connectivity, expected)
  }
  await page.screenshot({ path: join(output, 'x1-home.png') })
  await page.getByRole('textbox', { name: 'Search session names' }).fill(chatTitle)
  await page.getByRole('treeitem', { name: new RegExp(chatTitle) }).click()
  await page.getByRole('button', { name: 'Flows', exact: true }).click()
  await page.getByRole('button', { name: 'Fix bug with review', exact: true }).click()
  await page.getByLabel('Name', { exact: true }).waitFor()
  await page.locator('.react-flow__node').first().click()
  await page.getByLabel('Prompt template').waitFor()
  assert.equal(await page.getByLabel('workspace', { exact: true }).inputValue(), cwd)
  await page.getByText('Missing input bug', { exact: false }).waitFor({ state: 'attached' })
  await page.getByRole('button', { name: 'Validate', exact: true }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).waitFor()
  assert.ok(await page.getByText('Missing input bug', { exact: false }).count())
  await page.getByLabel('bug', { exact: true }).fill('Investigate the reported bug')
  await page.getByRole('button', { name: 'Run', exact: true }).and(page.locator(':enabled')).waitFor()
  assert.equal(await page.getByText('ENOENT', { exact: false }).count(), 0)
  await page.locator('.react-flow__node[data-id="you"]').click()
  await page.getByRole('button', { name: 'Fit graph' }).click()
  await mkdir(output, { recursive: true })
  await page.waitForTimeout(500) // Let ReactFlow's measured fit and the pane ResizeObserver settle.
  await page.screenshot({ path: join(output, 'x1-flows-editor.png') })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.screenshot({ path: join(output, 'x1-flows-editor-light.png') })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.getByRole('button', { name: 'Scripted UI preview', exact: true }).click()
  await page.locator('input[value="Scripted UI preview"]').waitFor()
  const keyboardSelect = async (element) => {
    await element.waitFor({ state: 'visible' })
    await element.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    assert.ok(await element.evaluate(node => node === document.activeElement), 'Tab must focus the graph element')
    await page.keyboard.press('Enter')
  }
  const mapNode = page.locator('.react-flow__node[data-id="map"]')
  const loopEdge = page.locator('.react-flow__edge[data-id="4"]')
  await keyboardSelect(loopEdge)
  await page.getByLabel('Maximum rounds').waitFor()
  await keyboardSelect(mapNode)
  await page.getByLabel('Label', { exact: true }).fill('Keyboard node edit')
  await mapNode.getByText('Keyboard node edit', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
  assert.equal(await mapNode.count(), 0)
  await page.getByRole('button', { name: 'Fix bug with review', exact: true }).click()
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await page.getByRole('button', { name: 'Scripted UI preview', exact: true }).click()
  await page.locator('input[value="Scripted UI preview"]').waitFor()
  await keyboardSelect(mapNode)
  await page.getByLabel('Label', { exact: true }).waitFor()
  await keyboardSelect(loopEdge)
  await page.getByLabel('Maximum rounds').fill('3')
  await loopEdge.getByText('Refuted · 3', { exact: false }).waitFor()
  await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
  assert.equal(await loopEdge.count(), 0)
  await page.getByRole('button', { name: 'Fix bug with review', exact: true }).click()
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await page.getByRole('button', { name: 'Scripted UI preview', exact: true }).click()
  await page.locator('input[value="Scripted UI preview"]').waitFor()
  const runButton = page.getByRole('button', { name: 'Run', exact: true })
  await runButton.click({ timeout: 30000 })
  await page.getByRole('button', { name: 'Approve', exact: true }).waitFor({ timeout: 60000 })
  assert.ok(await page.getByText('Step 4 of 5', { exact: true }).count())
  await page.getByRole('button', { name: 'Fit graph' }).click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(output, 'x1-flows-run.png') })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.screenshot({ path: join(output, 'x1-flows-run-light.png') })
  await page.emulateMedia({ colorScheme: 'dark' })
  const panel = page.getByRole('button', { name: 'Approve', exact: true }).locator('xpath=ancestor::section[1]')
  const expected = new URL('./expected/flow-run.aria.txt', import.meta.url)
  const actual = await panel.ariaSnapshot() + '\n'
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, actual)
  else assert.equal(actual, await readFile(expected, 'utf8'))
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await page.getByText('Step 5 of 5', { exact: true }).waitFor()
  await page.getByRole('textbox', { name: 'Search session names' }).fill(chatTitle)
  await page.getByRole('treeitem', { name: new RegExp(chatTitle) }).click()
  await page.getByRole('button', { name: /Completed in/ }).click()
  await page.getByRole('button', { name: 'Called tools', exact: true }).click()
  const openDock = page.getByRole('button', { name: 'Open Flow dock', exact: true })
  await openDock.waitFor()
  const card = openDock.locator('xpath=ancestor::section[1]')
  const chatExpected = new URL('./expected/flow-card.aria.txt', import.meta.url)
  const chatActual = await card.ariaSnapshot() + '\n'
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(chatExpected, chatActual)
  else assert.equal(chatActual, await readFile(chatExpected, 'utf8'))
  await openDock.click()
  await page.getByRole('button', { name: 'Approve', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Fit graph' }).click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(output, 'x1-flows-chat.png') })
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await page.getByText('Step 5 of 5', { exact: true }).first().waitFor()
  assert.deepEqual(errors, [])
  console.log('PASS: real editor, scripted run stream, Flow dock, chat run_flow card, approval, both themes, ARIA replay.')
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(output, 'x1-failure.png') })
    console.error(await page.locator('body').ariaSnapshot())
  }
  // Authentication URLs stay process-local even on failure.
  console.error(logs.replace(/http:\/\/\S+/g, '<LOCAL_URL>').slice(-12000))
  throw error
} finally {
  await browser?.close()
  if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGTERM')
  await exited
  await rm(temp, { recursive: true, force: true })
}
