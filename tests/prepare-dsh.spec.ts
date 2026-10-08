import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, symlink, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('resumes an owned preparation after interruption and refuses changed or unrelated outputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prepare-dsh-test-'))
  const source = join(root, 'source'), out = join(root, 'runtime'), plugin = join(root, 'plugin'), bin = join(root, 'bin')
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    return result.stdout
  }
  try {
    await Promise.all([source, join(plugin, 'scripts'), join(plugin, 'patches/dsh'), bin].map(path => mkdir(path, { recursive: true })))
    await copyFile(new URL('../scripts/prepare-dsh.sh', import.meta.url), join(plugin, 'scripts/prepare-dsh.sh'))
    await writeFile(join(source, 'value'), 'before\n')
    git('init'); git('add', 'value'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture')
    await writeFile(join(source, 'value'), 'after\n')
    const patch = join(plugin, 'patches/dsh/0001.patch')
    await writeFile(patch, git('diff'))
    await writeFile(join(source, 'value'), 'before\n')
    await writeFile(join(bin, 'pnpm'), '#!/bin/sh\n[ "${INTERRUPT:-}" != 1 ] || exit 73\nexit 0\n', { mode: 0o755 })
    const run = (target = out, interrupt = false) => spawnSync('bash', [join(plugin, 'scripts/prepare-dsh.sh'), source, target], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, INTERRUPT: interrupt ? '1' : '' }, encoding: 'utf8',
    })
    expect(run(out, true).status).toBe(73)
    expect(await readFile(join(out, 'value'), 'utf8')).toBe('after\n')
    for (let i = 0; i < 2; i++) { const result = run(); expect(result.status, result.stderr).toBe(0) }
    expect(git('status', '--porcelain')).toBe('')
    const unrelated = join(root, 'unrelated')
    await mkdir(unrelated)
    expect(run(unrelated).stderr).toContain('not a matching owned runtime')
    await writeFile(join(out, 'value'), 'unexpected\n')
    expect(run().stderr).toContain('unexpected unstaged changes')
    spawnSync('git', ['-C', out, 'add', 'value'])
    expect(run().stderr).toContain('unexpected staged changes')
    await writeFile(patch, `${await readFile(patch, 'utf8')}\n`)
    expect(run().stderr).toContain('not a matching owned runtime')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects canonical output and lock paths in the source before creating anything', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prepare-dsh-isolation-'))
  const source = join(root, 'source')
  const upstream = new URL('../../dsh-upstream', import.meta.url).pathname
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    return result.stdout
  }
  const upstreamStatus = git('-C', upstream, 'status', '--porcelain')
  try {
    // Never run rejection probes against the real upstream checkout.
    git('clone', '--shared', upstream, source)
    git('-C', source, 'remote', 'remove', 'origin')
    const before = git('-C', source, 'status', '--porcelain')
    expect(before).toBe('')
    const bin = join(root, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'pnpm'), '#!/bin/sh\nexit 73\n', { mode: 0o755 })
    const alias = join(root, 'source-alias')
    await symlink(source, alias)
    const lockOut = join(root, 'lock-output')
    await symlink(join(source, 'injected.lock'), `${lockOut}.switchboard-prepare.lock`)
    const rootLockOut = join(root, 'root-lock-output')
    await symlink(source, `${rootLockOut}.switchboard-prepare.lock`)
    for (const out of [join(source, 'new-parent/runtime'), source, alias,
      join(alias, 'new-parent/runtime'), lockOut, rootLockOut]) {
      const result = spawnSync('bash', [new URL('../scripts/prepare-dsh.sh', import.meta.url).pathname, source, out], {
        encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 15_000,
      })
      expect(result.status).not.toBe(0)
      expect(git('-C', source, 'status', '--porcelain')).toBe(before)
      expect(result.stderr).toContain('Output and lock must be outside the source checkout')
    }
    for (const path of [join(source, 'new-parent'), join(source, 'injected.lock'),
      `${source}.switchboard-prepare.lock`, lockOut, rootLockOut]) {
      await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
    expect(git('-C', upstream, 'status', '--porcelain')).toBe(upstreamStatus)
  }
}, 30_000)

it('owns every browser overlay instead of reaching into dsh test internals', async () => {
  const dir = new URL('../packages/ui/tests/', import.meta.url)
  expect(await readFile(new URL('fixtures/pin-browse-picker.overlay.yml', dir), 'utf8')).toContain('id:')
  for (const file of ['installed-web-smoke.mjs', 'flows-web-smoke.mjs', 'subscriptions-web-smoke.mjs']) {
    const source = await readFile(new URL(file, dir), 'utf8')
    expect(source).not.toContain('apps/web/tests/')
    expect(source).toContain('fixtures/pin-browse-picker.overlay.yml')
  }
})
