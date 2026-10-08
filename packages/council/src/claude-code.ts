/** Council-owned Claude instance. Permission policy is forced to plan, including on reload. */
import { ClaudeConfig, registerCouncilClaude } from './dsh.ts'
export const name = 'switchboard-council-claude-code'
export const inject = ['subagents', 'subprocess']
export const Config = ClaudeConfig
export const apply = registerCouncilClaude
