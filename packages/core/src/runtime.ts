/** Root-agent and shell execution over the current dsh capability services. */
import { randomUUID } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { type Context } from './dsh.ts'
import { brandString } from './dsh.ts'



import { createUserMessage, type TokenUsage } from './dsh.ts'
import { lastAssistantStreamChunk } from './dsh.ts'
import { type SessionId, type SessionEvent } from './dsh.ts'
import { setSandboxMode } from './dsh.ts'
import { setApprovalPolicy } from './dsh.ts'

import { type ToolDefinition } from './dsh.ts'

import { finalAssistantOutput } from './dsh.ts'
import { canonicalPath, gitRoot, snapshotFiles } from './files.ts'
import { inside } from './recipe.ts'
import type { AgentBlock, BlockResult, ChecksBlock } from './types.ts'
import type { PreflightEnvironment } from './preflight.ts'

/** Host-owned execution policy, configured through cordis.yml. */
export interface ExecutionConfig {
  maxAgents: number
  commandTimeoutMs: number
  outputBytes: number
  maxRunMinutes: number
  agentPreset?: string
}
/** Executor operations await per-request charges before tools or inference; missing dsh usage stops the run. */
export interface ExecutionEnvironment extends PreflightEnvironment {
  config: ExecutionConfig
  snapshot(cwd: string, signal: AbortSignal): Promise<Map<string, string>>
  checkChecks(): void
  /** Verify cwd after setup and immediately before each agent launch. */
  runAgent(
    block: AgentBlock, prompt: string, signal: AbortSignal, charge: (tokens: number) => void | Promise<void>, checkCwd: () => Promise<void>,
    lead?: { tools: ToolDefinition[]; instructions: string },
  ): Promise<BlockResult>
  /** Verify cwd immediately before every command, including later commands in the block. */
  runChecks(block: ChecksBlock, signal: AbortSignal, checkCwd: () => Promise<void>): Promise<BlockResult>
}

/** Calculate billable token volume without double-counting reasoning output.
 * @param usage - provider counters.
 * @returns total token volume.
 */
export function usageTokens(usage: TokenUsage): number {
  return usage.totalTokens ?? usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/** UTF-8-safe bounded output with an explicit truncation marker.
 * @param text - complete output.
 * @param bytes - maximum retained bytes, at least 32.
 * @returns bounded suffix suitable for check diagnostics and prompt reuse.
 */
export function outputTail(text: string, bytes: number): string {
  const buffer = Buffer.from(text)
  if (buffer.length <= bytes) return text
  const marker = '[truncated]\n'
  let start = buffer.length - bytes + Buffer.byteLength(marker)
  while (((buffer[start] ?? 0) & 0xc0) === 0x80) start++
  return marker + buffer.subarray(start).toString('utf8')
}

/** Build the real dsh adapter without starting work.
 * @param ctx - Host service owner.
 * @param config - resolved execution limits.
 * @returns preflight and execution operations.
 */
export function executionEnvironment(ctx: Context, config: ExecutionConfig): ExecutionEnvironment {
  function model(block: AgentBlock): { provider: string; model: string } {
    const defaults = ctx.get('agentDefaultModel')?.currentSelection()
    const provider = block.provider ?? defaults?.provider
    const selected = block.model ?? defaults?.model
    if (!provider || !selected) throw new Error('Select a provider and model or configure the default model')
    return { provider, model: selected }
  }
  return {
    config, maxAgents: config.maxAgents,
    checkChecks() { if (!ctx.get('shell')) throw new Error('Shell executor is unavailable') },
    async snapshot(cwd, signal) {
      const inventory = await snapshotFiles(cwd)
      const root = await gitRoot(cwd)
      if (!root) return inventory
      const shell = ctx.get('shell')
      if (!shell) throw new Error('Shell executor is required for Git write auditing')
      const execution = await shell.execute(shell.resolve({
        command: 'git --no-optional-locks status --porcelain=v1 -z --untracked-files=all --no-renames -- .',
        workdir: cwd, timeoutMs: config.commandTimeoutMs, stdoutMaxBytes: config.outputBytes, signal,
      }))
      const result = await execution.result()
      if (result.exitCode !== 0 || result.timedOut || result.aborted || result.stdout.truncated) {
        throw new Error('Git write audit failed or exceeded its output budget')
      }
      for (const row of result.stdout.text.split('\u0000').filter(Boolean)) {
        const path = relative(cwd, resolve(root, row.slice(3)))
        inventory.set(path, `${inventory.get(path) ?? 'missing'}:${row.slice(0, 2)}`)
      }
      return inventory
    },
    async checkAgent(block) {
      const presets = ctx.get('agentPresets')
      if (!ctx.get('agents') || !presets) throw new Error('Agent factory and agent presets must be composed')
      await presets.resolve(config.agentPreset)
      if (await gitRoot(block.scope.cwd) && !ctx.get('shell')) throw new Error('Git write auditing requires a shell executor')
      if (block.harness !== 'dsh') {
        const provider = block.provider ?? block.harness
        if (!ctx.get('subagents')?.list().includes(provider)) throw new Error(`Subagent provider ${provider} is unavailable`)
        if (block.model) throw new Error('Native model selection belongs to the configured named provider')
        return
      }
      const llm = ctx.get('llm')
      if (!llm) throw new Error('LLM adapters are unavailable')
      const selected = model(block)
      await llm.resolveModelInfo(selected.provider, selected.model)
    },
    async runAgent(block, prompt, parentSignal, charge, checkCwd, lead) {
      const accounting = new AbortController()
      const signal = AbortSignal.any([parentSignal, accounting.signal])
      let checkpoint = Promise.resolve()
      const accounted = async (): Promise<void> => { await checkpoint; signal.throwIfAborted() }
      if (Buffer.byteLength(prompt) > 65_536) throw new Error('Rendered prompt exceeds 64 KiB')
      const agents = ctx.get('agents')
      const presets = ctx.get('agentPresets')
      if (!agents || !presets) throw new Error('Agent factory and presets are unavailable')
      const preset = await presets.resolve(config.agentPreset)
      await using presetScope = await presets.acquireScope(preset.id)
      void presetScope
      const sessionId = brandString<SessionId>(`switchboard-${randomUUID()}`)
      const events: SessionEvent[] = []
      const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      const metering = { available: false }
      const stopEvents = ctx.on('session/event', (session, event) => {
        if (session.id !== sessionId) return
        if (event.type === 'assistant/message' || event.type === 'assistant/attempt' || event.type === 'turn/end') {
          const previous = events.findIndex(item => item.type === event.type)
          if (previous >= 0) events.splice(previous, 1)
          events.push(event)
        }
        if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return
        const part = (event.type === 'assistant/message' ? event.data.usage : undefined) ?? lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
        if (!part) { accounting.abort(new Error('Agent usage unavailable; inspect its session')); return }
        metering.available = true
        usage.inputTokens += part.inputTokens
        usage.outputTokens += part.outputTokens
        usage.totalTokens = (usage.totalTokens ?? 0) + usageTokens(part)
        usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (part.cacheReadTokens ?? 0)
        usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (part.cacheWriteTokens ?? 0)
        usage.reasoningTokens = (usage.reasoningTokens ?? 0) + (part.reasoningTokens ?? 0)
        checkpoint = checkpoint.then(() => charge(usageTokens(part)))
        void checkpoint.catch((error: unknown) => { accounting.abort(error) })
      })
      try {
        await checkCwd()
        signal.throwIfAborted()
        const handle = await agents.create({
          sessionId, signal, meta: { cwd: block.scope.cwd, agentPreset: preset.id },
          ...(block.harness === 'dsh' ? { agentOptions: model(block) } : {}),
          setup: async (agentCtx, agent) => {
            await presets.mount(agentCtx, preset.id)
            agentCtx.on('agent/request', async (_payload, next) => { await accounted(); return next() })
            setSandboxMode(agent.session, block.scope.sandbox)
            setApprovalPolicy(agent.session, 'never')
            const candidates = [
              ...(block.scope.read.length ? ['read', 'read_image', 'glob', 'grep'] : []),
              ...(block.scope.write.length ? ['write', 'edit'] : []),
              ...(block.scope.commands.length ? ['bash'] : []),
              ...(block.scope.web ? ['web_search', 'web_fetch'] : []),
            ]
            const tools = agentCtx.get('tools')
            if (!tools) throw new Error('Agent tool registry is unavailable')
            tools.presentAs('native')
            if (lead) for (const tool of lead.tools) agentCtx.effect(() => tools.register(tool))
            const allow = lead ? lead.tools.map(tool => tool.name)
              : candidates.filter(name => tools.schemas(agent).some(schema => schema.name === name))
            tools.restrict({ allow: lead ? [] : allow })
            tools.guard(exec => allow.includes(exec.name) ? undefined : `Tool ${exec.name} is outside this Flow scope`)
            agentCtx.on('tools/pre-execute', async (exec, next) => {
              await accounted()
              const args = exec.arguments
              if (args === null || typeof args !== 'object') return { kind: 'deny', reason: 'Expected tool arguments' }
              if (exec.name === 'bash') {
                const command: unknown = Reflect.get(args, 'command')
                if (typeof command !== 'string' || !block.scope.commands.includes(command)) return { kind: 'deny', reason: 'Command is outside this Flow scope' }
                const workdir: unknown = Reflect.get(args, 'workdir')
                if ((workdir !== undefined && (typeof workdir !== 'string' || resolve(block.scope.cwd, workdir) !== resolve(block.scope.cwd)))
                  || Reflect.get(args, 'run_in_background') === true || Reflect.get(args, 'sandbox_permissions') !== undefined) return { kind: 'deny', reason: 'Flow commands must run in cwd, in the foreground, without sandbox escalation' }
              } else if (['read', 'read_image', 'write', 'edit', 'glob', 'grep'].includes(exec.name)) {
                const raw: unknown = Reflect.get(args, ['glob', 'grep'].includes(exec.name) ? 'path' : 'file_path')
                const path = typeof raw === 'string' ? raw : '.'
                if (!inside(block.scope.cwd, path)) return { kind: 'deny', reason: 'Path is outside this Flow scope' }
                const grants = ['write', 'edit'].includes(exec.name) ? block.scope.write : block.scope.read
                const root = await canonicalPath(block.scope.cwd)
                const target = await canonicalPath(resolve(block.scope.cwd, path))
                const canonicalGrants = await Promise.all(grants.map(grant => canonicalPath(resolve(block.scope.cwd, grant))))
                if (!inside(root, target) || !canonicalGrants.some(grant => inside(root, grant) && inside(grant, target))) {
                  return { kind: 'deny', reason: 'Path is outside this Flow scope' }
                }
              }
              return next()
            })
            const system = agentCtx.get('systemPrompt')
            if (!system) throw new Error('System prompt service is unavailable')
            system.section({ name: 'switchboard:scope', order: system.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), interpolate: false, text: lead?.instructions ?? `Flow step scope: ${JSON.stringify(block.scope)}\nUse only the listed paths and exact commands. A review that rejects the work must start its final answer with REFUTED.` })
          },
        })
        const cancel = (): void => { handle.agent.cancel({ kind: 'parent' }) }
        signal.addEventListener('abort', cancel, { once: true })
        try {
          signal.throwIfAborted()
          if (block.harness !== 'dsh') {
            const subagents = ctx.get('subagents')
            if (!subagents) throw new Error(`Subagent provider ${block.provider ?? block.harness} is unavailable`)
            await checkCwd()
            signal.throwIfAborted()
            const run = await subagents.start(block.provider ?? block.harness, { parent: handle.agent, prompt: [{ type: 'text', text: `${prompt}\nScope: ${JSON.stringify(block.scope)}` }], signal })
            try {
              const result = await run.result
              const output = result.output.filter(part => part.type === 'text').map(part => part.text).join('\n')
              return {
                output: outputTail(output, config.outputBytes), refuted: /^\s*REFUTED\b/i.test(output), sessionId,
                ...(result.stopReason === 'completed' ? {} : { error: `Agent ended: ${result.stopReason}` }),
              }
            } finally { await run.dispose() }
          }
          await checkCwd()
          signal.throwIfAborted()
          handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
          await handle.agent.whenIdle()
          await accounted()
          const end = events.findLast(event => event.type === 'turn/end')
          const output = (finalAssistantOutput(events) ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
          await ctx.get('sessions')?.flush(handle.agent.session)
          return { output: outputTail(output, config.outputBytes), refuted: /^\s*REFUTED\b/i.test(output), sessionId, ...(metering.available ? { usage } : {}), ...(end?.data.reason.kind === 'completed' ? {} : { error: `Agent ended: ${end?.data.reason.kind ?? 'without a turn'}` }) }
        } finally {
          signal.removeEventListener('abort', cancel)
          await handle.dispose()
        }
      } finally { stopEvents() }
    },
    async runChecks(block, signal, checkCwd) {
      const shell = ctx.get('shell')
      if (!shell) throw new Error('Shell executor is unavailable')
      let output = ''
      for (const command of block.commands) {
        await checkCwd()
        signal.throwIfAborted()
        const execution = await shell.execute(shell.resolve({
          command, workdir: block.cwd, timeoutMs: config.commandTimeoutMs, stdoutMaxBytes: config.outputBytes, signal,
        }))
        const result = await execution.result()
        output = outputTail(`${output}\n$ ${command}\nexit=${result.exitCode} timedOut=${result.timedOut} aborted=${result.aborted}\n${result.stdout.text}\n${result.stderr.text}`, config.outputBytes)
        if (result.exitCode !== 0 || result.timedOut || result.aborted || result.signal || result.sandbox?.denied || result.sandbox?.runnerFailed) return { output, error: `Check failed: ${command}` }
      }
      return { output }
    },
  }
}
