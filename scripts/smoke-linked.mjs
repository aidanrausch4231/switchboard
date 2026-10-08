/** Temporarily point development links at the candidate runtime; always restore them. */
import { readdir, readlink, symlink, unlink, realpath } from 'node:fs/promises'
import { resolve, relative, join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
const root = resolve(import.meta.dirname, '..')
const stock = resolve(root, '../dsh-upstream')
const target = await realpath(process.argv[2])
const changed = []
let child
async function run(args) {
  child = spawn('pnpm', args, { cwd: root, env: { ...process.env, DSH_SMOKE_TARGET: target }, stdio: 'inherit' })
  const [code, signal] = await once(child, 'exit')
  child = undefined
  if (code !== 0) throw new Error(`pnpm ${args.join(' ')} failed: ${code ?? signal}`)
}
const interrupt = () => { child?.kill('SIGTERM') }
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
try {
  for (const base of [root, ...['core','council','fallback','bundle','ui'].map(name => join(root, 'packages', name))]) {
    const scope = join(base, 'node_modules/@deepseek-ai')
    for (const name of await readdir(scope)) {
      const path = join(scope, name)
      const original = await readlink(path)
      const destination = resolve(scope, original)
      if (!destination.startsWith(stock + '/')) continue
      const replacement = join(target, relative(stock, destination))
      await realpath(replacement) // refuse missing public dependency before unlinking
      changed.push({ path, original })
      await unlink(path); await symlink(replacement, path, 'dir')
    }
  }
  await run(['exec', 'tsc', '-b', '--clean'])
  await run(['run', 'check'])
  await run(['run', 'build']) // Loader tests consume the installed Host artifact too.
  await run(['test'])
  await run(['exec', 'vitest', 'run', 'packages/core/tests/headless.spec.ts'])
  console.log(`Upgrade smoke passed against ${target}`)
} finally {
  for (const { path, original } of changed.reverse()) { await unlink(path); await symlink(original, path, 'dir') }
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt)
}
