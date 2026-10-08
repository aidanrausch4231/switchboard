/** Keyless adapter used by both unit and real Loader compositions. */
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type StreamChunk } from '../src/dsh.ts'
import { type Context } from '../src/dsh.ts'

export class CouncilAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  respond: (options: GenerateOptions, prompt: string) => string | Promise<string> = (_options, prompt) => {
    if (prompt.includes('Write a ruling')) return '{"ruling":"Choose the reversible option.","dissent":[{"seat":"Seat B","point":"Cost remains uncertain."}],"confidence":0.8}'
    if (prompt.includes('Select the best answer')) return '{"choice":"Seat B","reason":"More complete evidence."}'
    return 'The reversible option is preferable.'
  }
  override listModels(): Promise<LlmModelInfo[]> {
    return Promise.resolve(['model-a', 'model-b', 'model-c'].map(id => ({ provider: 'fake', id, name: id })))
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const prompt = options.messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    const text = await this.respond(options, prompt)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
export const inject = ['llm']
export function apply(ctx: Context): void { ctx.llm.registerAdapter(['fake'], new CouncilAdapter()) }
