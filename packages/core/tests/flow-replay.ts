/** Owned full parent/child replay; public dsh test-support APIs supply only normalization/launching. */
import { cp, readFile, readdir, writeFile } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { SessionSnapshot as S, runLoaderSmoke, replayPlugin, Context, Persistence, brandString, type SessionId } from '../src/dsh.ts'

const plugin = fileURLToPath(new URL('../../../', import.meta.url))
const fixture = join(plugin, 'tests/snapshots/switchboard-flow')
const records = (log: string) => log.trim().split('\n').map(line => JSON.parse(line))
const contextOf = (logs: string[]) => ({ sessionIds: logs.map(log => records(log)[0].id as string), cwd: records(logs[0]!)[0].cwd as string })

export async function replayFlow(): Promise<void> {
  const runtime = resolve(process.env.DSH_SMOKE_TARGET ?? join(plugin, '../dsh-upstream'))
  const files = S.sessionFixtureNames(await readdir(fixture))
  const fixtures = await Promise.all(files.map(file => readFile(join(fixture, file), 'utf8')))
  const parent = records(fixtures[0]!)
  const task = parent.find(row => row.type === 'user/message').data.content[0].text
  const model = parent.find(row => row.type === 'request/header').data.header.config
  let initialWorkspace: Awaited<ReturnType<typeof S.captureWorkspaceSnapshot>> | undefined
  const workspaceOptions = { ignoredRootEntries: ['.agents', '.dsh', 'replay.json'] }
  const result = await runLoaderSmoke({
    label: 'Switchboard full Flow replay', tempDirPrefix: 'switchboard-flow-replay-',
    binScript: join(runtime, 'apps/cli/src/bin.ts'), mode: 'lib',
    tsconfigPath: join(plugin, 'tsconfig.json'), configPath: join(fixture, 'base.cordis.yml'),
    binArgs: ['--profile', 'headless', '--patch', join(fixture, 'base.cordis.yml'), '--patch', 'replay.json', '--patch', join(fixture, 'model.cordis.yml'), task],
    env: { DSH_SNAPSHOT: 'replay', DSH_SNAPSHOT_PROVIDER: model.provider, DSH_SNAPSHOT_MODEL: model.model,
      DSH_SNAPSHOT_FILE: join(fixture, files[0]!), DSH_SNAPSHOT_CHILD_FILES: files.slice(1).map(file => join(fixture, file)).join(delimiter),
      DSH_TELEMETRY_DISABLED: '1', NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
    prepare: async cwd => {
      await cp(join(fixture, 'workspace'), cwd, { recursive: true })
      await writeFile(join(cwd, 'replay.json'), JSON.stringify([
        { id: 'llm-deepseek', disabled: true },
        { insert: [
          { id: 'llm-replay', name: replayPlugin(runtime), config: { providers: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', defaultMaxTokens: 256000, reasoningEfforts: ['off', 'low', 'high', 'max'], defaultReasoningEffort: 'high' }] }] } },
          { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'snapshot-flow' } },
          { id: 'preset-snapshot-flow', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'snapshot-flow', plugins: [] } },
          { id: 'switchboard-core', name: join(plugin, 'packages/core/lib/index.js') },
          { id: 'snapshot-switchboard-flow', name: join(plugin, 'packages/core/tests/fixtures/snapshot-flow.ts') },
        ] },
      ]))
      initialWorkspace = await S.captureWorkspaceSnapshot(cwd, workspaceOptions)
    },
    inspect: async cwd => {
      const root = join(cwd, '.dsh/sessions')
      const paths = S.latestPersistedSessionPaths(await readdir(root, { recursive: true }))
      const logs = (await Promise.all(paths.map(file => readFile(join(root, file), 'utf8'))))
        .sort((a, b) => records(a)[0].createdAt - records(b)[0].createdAt)
      expect(logs).toHaveLength(2)
      const ctx = contextOf(logs)
      const actual = S.normalizeSessionSnapshots(logs, ctx, { nativeWriterOutput: true })
      const expected = S.normalizeSessionSnapshots(fixtures, contextOf(fixtures), { nativeWriterOutput: true })
      expect(actual.map(records)).toEqual(expected.map(records))
      const pinned = S.normalizedHeaders(fixtures[0]!, S.fixtureContext(fixtures[0]!))
      expect(pinned).toHaveLength(1)
      for (const [i, log] of logs.entries()) {
        const suffix = i ? `.${i}` : ''
        const schemas = S.parseToolSchemasSnapshot(await readFile(join(fixture, `tool-schemas${suffix}.expected.json`), 'utf8'))
        expect(schemas.changes).toEqual([])
        expect(S.normalizedHeaders(log, ctx)).toEqual([S.restorePinnedToolSchemas(pinned[0], schemas.initial)])
        expect(S.systemPromptPrecedesRequests(log)).toBe(true)
        const prompts = S.normalizedSystemPrompts(log, ctx)
        expect(prompts).toHaveLength(1)
        expect(S.formatSystemPromptSnapshot(prompts[0]!, prompts.slice(1))).toBe(await readFile(join(fixture, `system-prompt${suffix}.expected.md`), 'utf8'))
      }
      expect(initialWorkspace).toBeDefined()
      expect(await S.captureWorkspaceSnapshot(cwd, workspaceOptions)).toEqual(initialWorkspace)
      // Reopen both produced logs with only stock dsh persistence installed.
      const clean = new Context()
      try {
        await clean.plugin(Persistence, { root, compression: 'none' })
        for (const log of logs) {
          const stored = await clean.sessionPersistence.open(brandString<SessionId>(records(log)[0].id), 'read')
          try { await stored.read() } finally { await stored.close() }
        }
      } finally { await clean.fiber.dispose() }
    },
  })
  const final = parent.filter(row => row.type === 'assistant/message').at(-1).data.message.content[0].text
  expect(result.stdout).toBe(`${final}\n`)
  expect(result.stderr).toBe('')
}
