/** Typert currently inventories only workspace-owned declarations. Stage public built types,
 * never upstream source, beside our sources to give its exported generator an inventory. */
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { WorkspaceTypertGenerator } from './dsh.ts'
const root = resolve(import.meta.dirname, '..')
const stage = join(root, '.typert')
rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, 'packages'), { recursive: true })
symlinkSync(join(root, 'node_modules'), join(stage, 'node_modules'), 'dir')
const paths: Record<string, string[]> = {}
const references: { path: string }[] = []
for (const name of ['council', 'core']) {
  const source = join(root, 'packages', name), target = join(stage, 'packages', name)
  cpSync(join(source, 'src'), join(target, 'src'), { recursive: true })
  cpSync(join(source, 'package.json'), join(target, 'package.json'))
  symlinkSync(join(source, 'node_modules'), join(target, 'node_modules'), 'dir')
  paths[`@switchboard/${name}`] = [`./packages/${name}/src/index.ts`]
  paths[`@switchboard/${name}/types`] = [`./packages/${name}/src/types.ts`]
  references.push({ path: `./packages/${name}` })
}
const require = createRequire(join(root, 'packages/core/package.json'))
for (const name of ['dsh-typert-protocol', 'dsh-brand', 'dsh-llm', 'dsh-session']) {
  const manifestFile = require.resolve(`@deepseek-ai/${name}/package.json`)
  const source = dirname(manifestFile), target = join(stage, 'packages', name)
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  cpSync(join(source, 'lib/types'), join(target, 'types'), { recursive: true, filter: file => !file.endsWith('.js') && !file.endsWith('.map') })
  const exports: Record<string, string> = {}
  for (const [key, value] of Object.entries(manifest.exports)) {
    const type = typeof value === 'object' && value !== null ? (value as { types?: string }).types : undefined
    if (!type?.startsWith('./lib/types/') || key.includes('*')) continue
    const staged = type.replace('./lib/types/', './types/')
    exports[key] = staged
    paths[manifest.name + (key === '.' ? '' : key.slice(1))] = [`./packages/${name}/${staged}`]
  }
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: manifest.name, exports }))
  symlinkSync(join(source, 'node_modules'), join(target, 'node_modules'), 'dir')
  references.push({ path: `./packages/${name}` })
}
const options = JSON.parse(readFileSync(join(root, 'tsconfig.base.json'), 'utf8')).compilerOptions
writeFileSync(join(stage, 'tsconfig.base.json'), JSON.stringify({ compilerOptions: { ...options, paths } }))
for (const { path } of references) writeFileSync(join(stage, path, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.base.json', include: ['src', 'types'] }))
writeFileSync(join(stage, 'tsconfig.host.json'), JSON.stringify({ extends: './tsconfig.base.json', files: [], references }))
const generator = new WorkspaceTypertGenerator(stage, { checkDiagnostics: false })
for (const artifact of generator.generate(['@switchboard/council', '@switchboard/core'], ['host'])) {
  const out = join(root, 'packages', artifact.package.split('/')[1]!, 'lib')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'typert.host.js'), artifact.js)
  writeFileSync(join(out, 'typert.host.d.ts'), artifact.dts)
  if (!artifact.remote) throw new Error(`${artifact.package}: missing Remote artifact`)
  writeFileSync(join(out, 'typert.remote-client.js'), artifact.remote.js)
  writeFileSync(join(out, 'typert.remote-client.d.ts'), artifact.remote.dts)
}
console.log('Generated Host/Remote contracts from exported dsh declarations.')
