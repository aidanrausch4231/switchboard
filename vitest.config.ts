import { defineConfig } from 'vitest/config'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { standardDecoratorPlugin, vitestExecArgv } from './build/vitest-shared.ts'
const root = import.meta.dirname
const uiRequire = createRequire(resolve(root, 'packages/ui/package.json'))
/** Execute the real public browser factories in jsdom, using the same shared
 * platform modules as the shell. No upstream source or missing CSS companions. */
function builtClient() {
  return { name: 'built-client', enforce: 'pre' as const,
    resolveId(id: string, importer?: string) {
      if (id.startsWith('@deepseek-ai/') && id.endsWith('/client')) return '\0dsh-factory:' + uiRequire.resolve(id)
      if (importer?.startsWith('\0dsh-factory:') && !id.startsWith('\0')) return createRequire(importer.slice(13)).resolve(id)
    },
    load(id: string) {
      if (!id.startsWith('\0dsh-factory:')) return
      const code = readFileSync(id.slice(13), 'utf8').replace(/\/\/# sourceMappingURL=.*$/gm, '')
      const imports = [...new Set([...code.matchAll(/\brequire\("([^"\n]+)"\)/g)].map(m => m[1]!))]
      const exports = [...new Set([...code.matchAll(/^\s*exports\.(\w+)\s*=/gm)].map(m => m[1]!))]
      if (!exports.length) throw new Error(`No factory exports: ${id}`)
      return imports.map((name, i) => `import * as m${i} from ${JSON.stringify(name)};`).join('\n')
        + '\nconst modules = {' + imports.map((name, i) => `${JSON.stringify(name)}:m${i}`).join(',') + '};\nlet result;\nfunction capture(row) { result = row.factory(name => { if (!(name in modules)) throw new Error("Unprovided factory module: " + name); return modules[name]; }); }\n'
        + code.replace('window.__ModuleLoader__.load(', 'capture(')
        + '\n' + exports.map(name => name === 'default' ? 'export default result.default;' : `export const ${name} = result.${name};`).join('\n')
    },
  }
}
export default defineConfig({
  plugins: [builtClient(), standardDecoratorPlugin()],
  resolve: { alias: [
    { find: /^react$/, replacement: uiRequire.resolve('react') },
    { find: /^react\/(.*)/, replacement: resolve(dirname(uiRequire.resolve('react/package.json')), '$1') },
    { find: /^react-dom$/, replacement: uiRequire.resolve('react-dom') },
    ...['core', 'council', 'fallback'].map(pkg => ({ find: new RegExp(`^@switchboard/${pkg}$`), replacement: resolve(root, `packages/${pkg}/src/index.ts`) })),
  ] },
  test: {
    include: ['packages/*/tests/**/*.spec.{ts,tsx}', 'tests/**/*.spec.ts'],
    maxWorkers: 1, fileParallelism: false, testTimeout: 30000, hookTimeout: 30000,
    execArgv: vitestExecArgv, setupFiles: ['./tests/dom.ts'],
    server: { deps: { inline: [/dsh-upstream/, /@switchboard/, ...(process.env.DSH_SMOKE_TARGET ? [process.env.DSH_SMOKE_TARGET] : [])] } },
  },
})
