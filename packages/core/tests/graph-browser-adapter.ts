/** Keyless external-model replacement for the real Graphs browser composition. */
import { type Context } from '../src/dsh.ts'
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type StreamChunk } from '../src/dsh.ts'
import { textResponse, toolCallResponse } from './fixtures/mock-adapter.ts'

class GraphBrowserAdapter extends LlmAdapter {
  override listModels(): Promise<LlmModelInfo[]> {
    return Promise.resolve([{ provider: 'graph-fixture', id: 'scripted', name: 'Scripted Graphs fixture' }])
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = options.messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    let chunks: StreamChunk[]
    if (text.startsWith('Route this untrusted inbox text')) {
      chunks = textResponse(JSON.stringify({ target: 'billing', confidence: 0.95, reason: 'Invoice question for the Billing lead (keyless model fixture).' }))
    } else if (options.tools?.some(tool => tool.name === 'dispatch')) {
      const calls = options.messages.flatMap(message => message.content).filter(block => block.type === 'tool-call')
      const responses = [
        toolCallResponse('memory', 'read_memory', {}),
        toolCallResponse('note', 'append_note', { name: 'browser-check.md', text: 'Invoice explanation verified against the local workspace.' }),
        toolCallResponse('dispatch', 'dispatch', { nodeId: 'billing-reader', input: '{"task":"Explain the invoice"}' }),
        toolCallResponse('done', 'done', { summary: 'Invoice explained from the local read-only billing node.' }),
      ]
      chunks = responses[calls.length] ?? textResponse('Finished.')
    } else chunks = textResponse('The local invoice includes one additional service day. No files changed.')
    for (const chunk of chunks) { options.signal?.throwIfAborted(); yield chunk }
  }
}
export const inject = ['llm']
export function apply(ctx: Context): void { ctx.effect(() => ctx.llm.registerAdapter(['graph-fixture'], new GraphBrowserAdapter())) }
