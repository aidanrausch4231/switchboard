/** Installed-bundle browser acceptance. All state stays in a new isolated home; no live model calls. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const plugin = fileURLToPath(new URL('../../../', import.meta.url))
const runtime = resolve(process.env.DSH_RUNTIME ?? join(plugin, '../dsh-runtime'))
const output = resolve(process.argv[2])
await mkdir(output, { recursive: true })
const temp = await mkdtemp(join(tmpdir(), 'x1-installed-'))
const env = { ...process.env, DSH_HOME: join(temp, 'home'), DSH_RUNTIME: runtime }
for (const name of Object.keys(env)) if (/KEY|SECRET|TOKEN|PASSWORD/.test(name)) delete env[name]
function setup(args) {
  const result = spawnSync('pnpm', ['dsh', ...args], { cwd: runtime, env, encoding: 'utf8', timeout: 90000 })
  assert.equal(result.status, 0, `Profile setup failed: ${result.stderr}`)
}
async function test(file, args) {
  const child = spawn(process.execPath, [join(plugin, 'packages/ui/tests', file), ...args], { cwd: plugin, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', chunk => { log += chunk }); child.stderr.on('data', chunk => { log += chunk })
  const [code] = await once(child, 'exit')
  console.log(log.replace(/http:\/\/\S+/g, '<LOCAL_URL>'))
  assert.equal(code, 0, `${file} failed`)
}
setup(['--profile', 'switchboard', '--from-default-profile', 'web', '--dump-config'])
setup(['plugin', '--profile', 'switchboard', 'add', join(plugin, 'packages/bundle')])
await test('flows-web-smoke.mjs', [output])
const patch = join(temp, 'overlay.json')
await writeFile(patch, JSON.stringify([
  { id: 'hmr', disabled: true }, { id: 'open-in-app', disabled: true }, { id: 'ui-open-in-app', disabled: true },
  { id: 'llm-deepseek', disabled: true }, { id: 'session-title-llm', disabled: true },
  { id: 'switchboard-core', config: { fallbackRouterProvider: 'graph-fixture', fallbackRouterModel: 'scripted' } },
  { id: 'switchboard-council', config: { chair: 'a', seats: [
    ...['a','b','c','d','e'].map((id,index) => ({ id, label: ['Research chair','Engineering','Systems','Operations','Review'][index], kind: 'llm', provider: 'fake', model: `model-${['a','b','c','a','b'][index]}`, enabled: true })),
    { id: 'codex', label: 'Codex', kind: 'subagent', subagent: 'codex', provider: 'codex', enabled: true },
  ] } },
  { insert: [
    { id: 'graphs-fixture', name: join(plugin, 'packages/core/tests/graph-browser-adapter.ts') },
    { id: 'council-fixture', name: join(plugin, 'packages/council/tests/adapter.ts') },
    { id: 'automations-fixture', name: join(plugin, 'packages/core/tests/fixtures/automation-web.ts') },
  ] },
]))
const child = spawn('pnpm', ['dsh', '--profile', 'switchboard', '--patch', patch, '--patch', join(plugin, 'packages/ui/tests/fixtures/pin-browse-picker.overlay.yml'), '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: runtime, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
const exited = once(child, 'exit')
let log = ''
child.stdout.on('data', chunk => { log += chunk }); child.stderr.on('data', chunk => { log += chunk })
try {
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => { clean(); reject(new Error('No ready URL')) }, 90000)
    const clean = () => { clearTimeout(timer); child.stdout.off('data', inspect); child.stderr.off('data', inspect); child.off('exit', failed) }
    const failed = code => { clean(); reject(new Error(`Host exited ${code}`)) }
    const inspect = () => { const match = log.match(/http:\/\/127\.0\.0\.1:\d+\S*/); if (match) { clean(); resolveUrl(match[0].replace(/\x1b\[[\d;]*m/g, '')) } }
    child.stdout.on('data', inspect); child.stderr.on('data', inspect); child.on('exit', failed); inspect()
  })
  await test('web-smoke.mjs', [url, join(output, 'x1-navigation.png')])
  await test('automations-web-smoke.mjs', [url, join(output, 'x1-automations.png')])
  await test('graphs-web-smoke.mjs', [url, join(output, 'x1-graphs.png'), join(output, 'x1-graphs-inside.png')])
  await test('council-web-smoke.mjs', [url, join(output, 'x1-council.png')])
  await test('voice-web-smoke.mjs', [url, join(output, 'x1-voice.png')])
  console.log(`Installed browser smoke passed: ${temp}`)
} finally {
  if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGTERM')
  await exited
  await writeFile(join(temp, 'server-redacted.log'), log.replace(/http:\/\/\S+/g, '<LOCAL_URL>'))
}
