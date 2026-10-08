/** Keyless supported-profile smoke: real routes/Remote/UI, mocked OAuth only, isolated DSH_HOME. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const runtime = resolve(process.env.DSH_RUNTIME ?? join(root, '../dsh-runtime'))
const output = process.argv[2]
assert.ok(output, 'Pass a screenshot directory')
const temp = await mkdtemp(join(tmpdir(), 'p9-signin-'))
const env = { ...process.env, DSH_HOME: join(temp, 'home') }
for (const name of Object.keys(env)) if (/KEY|SECRET|TOKEN|PASSWORD/.test(name)) delete env[name]
await mkdir(output, { recursive: true })
function setup(args) {
  const result = spawnSync('pnpm', ['dsh', ...args], { cwd: runtime, env, encoding: 'utf8', timeout: 90000 })
  assert.equal(result.signal, null, 'Profile setup exceeded its deadline')
  assert.equal(result.status, 0, `Profile setup failed (${args[0]})`)
}
setup(['--profile', 'switchboard', '--from-default-profile', 'web', '--dump-config'])
setup(['plugin', '--profile', 'switchboard', 'add', resolve(root, 'packages/bundle')])
const patch = join(temp, 'overlay.json')
await writeFile(patch, JSON.stringify([
  { id: 'switchboard-core', name: resolve(root, 'packages/core/lib/index.js') },
  { id: 'switchboard-ui', name: resolve(root, 'packages/ui/lib/index.js') },
  { id: 'open-in-app', disabled: true }, { id: 'ui-open-in-app', disabled: true },
  { id: 'llm-deepseek', disabled: true }, { id: 'session-title-llm', disabled: true },
  { id: 'hmr', disabled: true },
  { insert: [{ id: 'subscriptions-fixture', name: resolve(root, 'packages/core/tests/fixtures/subscriptions-web.ts') }] },
]))
const child = spawn('pnpm', ['dsh', '--profile', 'switchboard', '--patch', patch, '--patch', fileURLToPath(new URL('./fixtures/pin-browse-picker.overlay.yml', import.meta.url)), '--host', '127.0.0.1', '--port', '0', '--no-open'], {
  cwd: runtime, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
const exited = once(child, 'exit')
let logs = '', browser, page
child.stdout.on('data', chunk => { logs += chunk })
child.stderr.on('data', chunk => { logs += chunk })
const errors = [], remoteFrames = [], responseReads = []
try {
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => { clean(); reject(new Error('No ready URL')) }, 90000)
    const clean = () => { clearTimeout(timer); child.stdout.off('data', inspect); child.stderr.off('data', inspect); child.off('exit', failed) }
    const failed = code => { clean(); reject(new Error(`Host exited ${code}`)) }
    const inspect = () => { const match = logs.match(/http:\/\/127\.0\.0\.1:\d+\S*/); if (match) { clean(); resolveUrl(match[0].replace(/\x1b\[[\d;]*m/g, '')) } }
    child.stdout.on('data', inspect); child.stderr.on('data', inspect); child.on('exit', failed); inspect()
  })
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', colorScheme: 'dark', reducedMotion: 'reduce' })
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text().replace(/http:\/\/\S+/g, '<LOCAL_URL>')) })
  page.on('websocket', socket => { socket.on('framereceived', frame => remoteFrames.push(String(frame.payload))) })
  await page.addLocatorHandler(page.getByRole('button', { name: /^(Continue|继续)$/ }), button => button.click())
  await page.addLocatorHandler(page.getByRole('button', { name: 'Configure later', exact: true }), button => button.click())
  page.on('response', response => {
    if (new URL(response.url()).pathname.startsWith('/api/')) responseReads.push(response.text().then(text => {
      remoteFrames.push(text)
    }).catch(() => { errors.push('Could not inspect an API response') }))
  })
  await page.goto(url, { waitUntil: 'load' })
  const button = name => page.getByRole('button', { name, exact: true })
  await button('Switchboard').click({ timeout: 60000 })
  await page.getByText('Connected', { exact: true }).waitFor()
  await page.removeLocatorHandler(page.getByRole('button', { name: /^(Continue|继续)$/ }))
  const main = page.getByRole('main')
  await main.getByRole('group', { name: 'ChatGPT' }).waitFor()
  const ping = JSON.parse(await main.locator('pre').innerText())
  const home = (await main.ariaSnapshot()).replaceAll(ping.time, '<HOST_TIME>').replaceAll(ping.version, '<VERSION>') + '\n'
  const homeExpected = new URL('./expected/page.aria.txt', import.meta.url)
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(homeExpected, home)
  else assert.equal(home, await readFile(homeExpected, 'utf8'))
  await page.screenshot({ path: join(output, 'x1-signin-home.png') })
  await button('Subscriptions').click()
  const row = name => page.getByRole('group', { name, exact: true })
  const chatgpt = row('ChatGPT')
  await chatgpt.getByRole('button', { name: 'Sign in', exact: true }).click()
  await chatgpt.getByRole('button', { name: 'Device code', exact: true }).click()
  await chatgpt.getByText('ABCD-1234', { exact: true }).waitFor()
  assert.equal(await chatgpt.getByRole('link', { name: 'Open sign-in page' }).getAttribute('href'), 'https://example.com/device')
  await page.screenshot({ path: join(output, 'x1-signin-device.png') })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.screenshot({ path: join(output, 'x1-signin-device-light.png') })
  await page.emulateMedia({ colorScheme: 'dark' })
  await chatgpt.getByRole('button', { name: 'Cancel', exact: true }).click()
  await chatgpt.getByText('Sign-in cancelled', { exact: true }).waitFor()
  await chatgpt.getByRole('button', { name: 'Sign in', exact: true }).click()
  await chatgpt.getByRole('button', { name: 'Browser login', exact: true }).click()
  const paste = chatgpt.getByLabel('Paste the authorization code or redirect URL')
  await paste.waitFor()
  await page.screenshot({ path: join(output, 'x1-signin-browser.png') })
  await paste.fill('MOCK_PRIVATE_PASTED_CODE')
  await chatgpt.getByRole('button', { name: 'Continue', exact: true }).click()
  await chatgpt.getByText('Signed in ✓', { exact: true }).waitFor()
  await chatgpt.getByText('Models enabled', { exact: true }).waitFor()
  await row('xAI').getByRole('button', { name: 'Sign in', exact: true }).click()
  await row('xAI').getByRole('alert').waitFor()
  assert.equal(await row('xAI').getByRole('alert').textContent(), 'Sign-in failed. Try again and check that your subscription supports this provider.')
  const snapshot = await main.ariaSnapshot() + '\n'
  const expected = new URL('./expected/subscriptions.aria.txt', import.meta.url)
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, snapshot)
  else assert.equal(snapshot, await readFile(expected, 'utf8'))
  await page.screenshot({ path: join(output, 'x1-signin-ready.png') })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.screenshot({ path: join(output, 'x1-signin-ready-light.png') })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.getByRole('button', { name: 'New session', exact: true }).last().click()
  await page.getByRole('button', { name: /^Select model, current/ }).click()
  await page.getByRole('menuitem', { name: /^Model\b/ }).click()
  const model = page.getByRole('menuitemradio').filter({ hasText: /GPT-5/ }).first()
  await model.waitFor()
  assert.notEqual(await model.getAttribute('aria-disabled'), 'true')
  const modelName = await model.innerText()
  await model.click()
  await page.getByRole('button', { name: /^Select model, current/ }).filter({ hasText: modelName }).waitFor()
  await button('Subscriptions').click()
  await chatgpt.getByText('Signed in ✓', { exact: true }).waitFor()
  await chatgpt.getByRole('button', { name: 'Sign out', exact: true }).click()
  await chatgpt.getByRole('button', { name: 'Sign in', exact: true }).waitFor()
  await chatgpt.getByText('Models enabled', { exact: true }).waitFor()
  for (const name of ['Kimi', 'Meta', 'xAI']) {
    const provider = row(name)
    await provider.getByRole('button', { name: 'Sign in', exact: true }).click()
    await provider.getByText('ABCD-1234', { exact: true }).waitFor()
    assert.equal(await provider.getByRole('link', { name: 'Open sign-in page' }).count(), 0, `${name} exposed a secret-bearing URL`)
    assert.equal((await provider.innerHTML()).includes('MOCK_PRIVATE_'), false)
    await provider.getByRole('button', { name: 'Cancel', exact: true }).click()
    await provider.getByText('Sign-in cancelled', { exact: true }).waitFor()
  }
  await Promise.all(responseReads)
  assert.deepEqual(errors, [])
  assert.equal(/MOCK_PRIVATE_(ACCESS_TOKEN|REFRESH_TOKEN|PASTED_CODE|DEVICE_CODE|EXCHANGE_SECRET)/.test(logs + remoteFrames.join('') + await page.locator('body').innerHTML()), false, 'Private OAuth data reached a response, UI or log')
  console.log(`Subscriptions browser smoke passed; isolated home: ${temp}`)
} catch (error) {
  console.error(String(error).replace(/http:\/\/\S+/g, '<LOCAL_URL>'))
  if (page) {
    await page.screenshot({ path: join(temp, 'failure.png') })
    await writeFile(join(temp, 'failure.aria.txt'), await page.locator('body').ariaSnapshot())
  }
  console.error(JSON.stringify({ errors }))
  console.error(`Evidence: ${temp}`)
  process.exitCode = 1
} finally {
  await browser?.close()
  if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGTERM')
  await exited
  await writeFile(join(temp, 'server-redacted.log'), logs.replace(/http:\/\/\S+/g, '<LOCAL_URL>').replace(/MOCK_PRIVATE_[A-Z_]+/g, '<MOCK_SECRET>'))
}
