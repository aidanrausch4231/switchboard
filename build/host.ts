import type { UserConfig } from 'tsdown'
/** Host artifacts share dsh's service identities instead of bundling a second runtime. */
export function host(entry = ['lib/types/index.js']): UserConfig {
  return {
    entry, outDir: 'lib', format: 'esm', platform: 'node', target: 'es2024',
    fixedExtension: false, dts: false, clean: false,
    deps: { neverBundle: [/^@deepseek-ai\//, /^@switchboard\//] },
    treeshake: { moduleSideEffects: false },
  }
}
