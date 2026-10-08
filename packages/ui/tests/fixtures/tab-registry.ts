/** Minimal owned registry fixture: this suite tests our registration/disposal, not dsh routing. */
import { type Context } from '../../src/client/dsh.ts'
type Definition = Parameters<Context['sidebarRightTabs']['register']>[0]
export class SidebarRightTabRegistry {
  private readonly tabs = new Map<string, Definition>()
  constructor(_ctx: Context) {}
  register(definition: Definition): () => void {
    this.tabs.set(definition.kind, definition)
    return () => { this.tabs.delete(definition.kind) }
  }
  get(kind: string): Definition | undefined { return this.tabs.get(kind) }
}
