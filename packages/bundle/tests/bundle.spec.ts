import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'

it('declares the Council, a dedicated plan-only Claude instance, and privacy defaults', () => {
  const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  expect(manifest).toMatchObject({
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    dependencies: {
      '@switchboard/core': 'workspace:*',
      '@switchboard/ui': 'workspace:*',
    },
  })
  expect(load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))).toEqual([
    { insert: [
      { id: 'claude-code-council', name: '@switchboard/council/claude-code', config: { providerName: 'claude-code-council', permissionMode: 'plan' } },
      { id: 'switchboard-council', name: '@switchboard/council' },
      { id: 'switchboard-core', name: '@switchboard/core' },
      { id: 'switchboard-ui', name: '@switchboard/ui' },
    ] },
    { id: 'session-log-deepseek', config: { enabled: false } },
    { id: 'plugin-package-inventory-deepseek', config: { enabled: false } },
    { id: 'session-telemetry-otel', disabled: true },
  ])
})
