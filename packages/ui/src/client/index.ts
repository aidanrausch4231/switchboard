/** Mount Switchboard's generated Remote contribution before its browser consumer. */
import { type Context } from './dsh.ts'

import switchboardRemote from '@switchboard/core/remote'
import councilRemote from '@switchboard/council/remote'
import * as presentation from './presentation.ts'
import * as councilPresentation from './council-presentation.ts'
import * as automations from './automation-presentation.tsx'
import * as graphsPresentation from './graphs-presentation.ts'
import * as subscriptions from './subscriptions-presentation.ts'

/** The Remote assembly needs only the transport service. */
export const inject = ['remote']

/**
 * Mount the generated namespace and its dependent presentation plugin.
 * @param ctx - browser Cordis context.
 */
export async function apply(ctx: Context): Promise<void> {
  const dispose = await ctx.remote.$mount(switchboardRemote)
  ctx.effect(() => dispose, 'switchboard: Remote contribution')
  const disposeCouncil = await ctx.remote.$mount(councilRemote)
  ctx.effect(() => disposeCouncil, 'switchboard: Council Remote contribution')
  ctx.plugin(presentation)
  ctx.plugin(councilPresentation)
  ctx.plugin(automations)
  ctx.plugin(graphsPresentation)
  ctx.plugin(subscriptions)
}
