/** Minimal owned dsh closure-factory/CSS preset, adapted from dsh (MIT, 5badb15009).
 * No repository scan, upstream source import, static shell build or dynamic chunks. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'
import { host } from './host.ts'
const platform = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit'])
const inline = /^@deepseek-ai\/(?:schemastery|cosmokit|dsh-(?:brand|llm|session|typert-protocol|util-crypto|util-values))(?:\/|$)/
export function clientBundle(id: string): UserConfig[] {
  const external = (name: string) => platform.has(name) || (name.startsWith('@deepseek-ai/') && !inline.test(name))
  return [host(), {
    name: `${id}/client`, entry: { client: 'src/client/index.ts' }, outDir: 'lib',
    format: 'cjs', platform: 'browser', target: 'es2024', dts: false, clean: false,
    sourcemap: true, treeshake: { moduleSideEffects: name => name.includes('css:') || name.endsWith('.css') },
    deps: { neverBundle: external, alwaysBundle: name => !external(name) },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.MODE': '"production"', 'import.meta.env': '{"MODE":"production"}' },
    plugins: [{
      name: 'switchboard-css',
      resolveId(source, importer) {
        if (!source.endsWith('.css') || !importer) return
        const file = source.startsWith('.') ? resolve(dirname(importer), source) : createRequire(importer).resolve(source)
        return '\0css:' + file + '.mjs'
      },
      load(id) {
        if (!id.startsWith('\0css:')) return
        const file = id.slice(5, -4)
        this.addWatchFile(file)
        const result = transform({ filename: file, code: readFileSync(file), minify: true, ...(file.endsWith('.module.css') ? { cssModules: { pattern: '[hash]_[local]' } } : {}) })
        const classes = Object.fromEntries(Object.entries(result.exports ?? {}).map(([key, value]) => [key, value.name]))
        return `const css = ${JSON.stringify(result.code.toString())};\nconst key = ${JSON.stringify('@switchboard/ui/' + basename(file))};\nif (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css=' + JSON.stringify(key) + ']')) { const tag = document.createElement('style'); tag.dataset.pluginCss = key; tag.dataset.plugin = '@switchboard/ui'; tag.textContent = css; document.head.appendChild(tag); }\nexport default ${JSON.stringify(classes)};`
      },
      generateBundle(_options, bundle) {
        for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') {
          for (const imported of chunk.imports) if (!platform.has(imported)) throw new Error(`Unprovided browser module: ${imported}`)
          if (chunk.dynamicImports.length) throw new Error('Add chunk-loader support before using dynamic imports')
        }
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({id: ${JSON.stringify(id)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  }]
}
