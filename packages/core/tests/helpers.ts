import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '../src/dsh.ts'
import { Timer } from '../src/dsh.ts'
import { Storage } from '../src/dsh.ts'
import { DshStorageJson as StorageJson } from '../src/dsh.ts'
import { DshStorageDomain as StorageDomain } from '../src/dsh.ts'
import { onTestFinished } from 'vitest'
import { switchboardDomain } from '../src/storage.ts'
import { FlowEngine } from '../src/engine.ts'
import { snapshotFiles } from '../src/files.ts'
import type { ExecutionEnvironment } from '../src/runtime.ts'
import type { Flow, FlowId } from '../src/types.ts'

export async function temp(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'switchboard-flow-'))
  onTestFinished(async () => { await rm(path, { recursive: true, force: true }) })
  return path
}
export function recipe(cwd: string): Flow {
  return {
    id: 'test' as FlowId, name: 'Test flow', version: 1, inputs: [{ name: 'task', type: 'string', default: 'fix' }],
    blocks: [{ id: 'build', kind: 'agent', label: 'Build', harness: 'dsh', prompt: '{{inputs.task}}', scope: { cwd, read: ['.'], write: [], commands: [], web: false, sandbox: 'read-only' } }], edges: [], limits: {},
  }
}
export function fakeEnvironment(overrides: Partial<ExecutionEnvironment> = {}): ExecutionEnvironment {
  return { config: { maxAgents: 64, commandTimeoutMs: 1000, outputBytes: 32768, maxRunMinutes: 1 }, maxAgents: 64, snapshot: snapshotFiles, checkChecks() {}, async checkAgent() {}, async runAgent() { return { output: 'APPROVED' } }, async runChecks() { return { output: 'exit=0' } }, ...overrides }
}
export async function storageContext(root: string): Promise<Context> {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Timer)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  return ctx
}
export async function engineHarness(environment = fakeEnvironment()) {
  const root = await temp()
  const cwd = await temp()
  const ctx = await storageContext(root)
  const domain = await ctx.storageDomain.open(switchboardDomain)
  const engine = new FlowEngine(domain, environment)
  onTestFinished(async () => { await engine.dispose(); await domain.close() })
  return { root, cwd, ctx, domain, engine }
}
