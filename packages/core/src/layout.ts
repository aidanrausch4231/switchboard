/** Editor placement has an independent storage lifecycle from executable recipes. */
import { z } from 'zod'
import { defineDomain, domainTable } from './dsh.ts'
import type { FlowId, FlowLayout } from './types.ts'

/** Wire and durable layout parser; coordinates must be finite. */
export const layoutSchema = z.strictObject({ positions: z.array(z.strictObject({ id: z.string().min(1), x: z.number(), y: z.number() })) })
/** Editor-only domain; adding positions does not rewrite version-one run snapshots. */
export const layoutDomain = defineDomain({ name: 'switchboard_layout', version: 1, tables: { layouts: domainTable<FlowId, FlowLayout>(layoutSchema) } })
