import assert from 'node:assert/strict'
import { Context } from '../src/dsh.ts'
import { Loader } from '../src/dsh.ts'
import { Include } from '../src/dsh.ts'
import { createUserMessage, LlmAdapter, resolveRetryPolicy } from '../src/dsh.ts'
import { SessionId } from '../src/dsh.ts'

class Adapter extends LlmAdapter {
  requests = []
  providerRetryPolicy() {
    return resolveRetryPolicy({
      mode: 'normal', maxRetries: 1,
      backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    }, 'built fallback smoke')
  }
  async * stream(options) {
    this.requests.push(options.provider)
    if (this.requests.length <= 2) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'unavailable' } } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'recovered' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'recovered' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const ctx = new Context()
try {
  ctx.baseUrl = new URL('./fixtures/', import.meta.url).href
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({
    name: 'cordis:include', config: { path: new URL('./fixtures/cordis.yml', import.meta.url).href },
  })
  await ctx.loader.await()
  assert.deepEqual([...ctx.loader.entries()]
    .filter(entry => !entry.disabled && entry.fiber === undefined)
    .map(entry => entry.options.name), [])
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['deepseek-official', 'openrouter'], adapter)
  const events = []
  ctx.on('switchboard/fallback', event => { events.push(event) })
  const handle = await ctx.agents.create({
    sessionId: SessionId('built-fallback-smoke'),
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  })
  for (let turn = 0; turn < 2; turn++) {
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
  }
  assert.deepEqual(adapter.requests, ['deepseek-official', 'deepseek-official', 'openrouter', 'deepseek-official'])
  assert.equal(events.length, 1)
  assert.deepEqual(handle.agent.session.snapshotEvents().flatMap(event => event.type === 'assistant/message'
    ? [event.data.message.source.provider] : []), ['openrouter', 'deepseek-official'])
  console.log('Built Loader fallback smoke passed (no network)')
} finally {
  await ctx.fiber.dispose()
}
