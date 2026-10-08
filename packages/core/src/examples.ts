/** Shipped starter recipes; tests keep these values aligned with the source JSON examples. */
import { flowSchema } from './recipe.ts'

/** Starter recipes seeded into empty stores and used to upgrade unchanged version-1 seeds. */
export const exampleFlows = [
  flowSchema.parse({
    'id': 'fix-bug-with-review',
    'name': 'Fix bug with review',
    'version': 2,
    'inputs': [{ 'name': 'workspace', 'type': 'path', 'required': true }, { 'name': 'bug', 'type': 'string' }],
    'blocks': [
      { 'kind': 'agent', 'id': 'map', 'label': 'Map', 'harness': 'dsh', 'prompt': 'Locate the cause of {{inputs.bug}}. Do not edit files.', 'scope': { 'cwd': '{{inputs.workspace}}', 'read': ['.'], 'write': [], 'commands': [], 'web': false, 'sandbox': 'read-only' } },
      { 'kind': 'agent', 'id': 'build', 'label': 'Build', 'harness': 'dsh', 'prompt': 'Fix {{inputs.bug}} using this map: {{blocks.map.output}}. Edit only src/ and add a focused regression test there. Previous review (empty on the first pass): {{blocks.review.output}}', 'scope': { 'cwd': '{{inputs.workspace}}', 'read': ['.'], 'write': ['src'], 'commands': [], 'web': false, 'sandbox': 'workspace-write' } },
      { 'kind': 'checks', 'id': 'checks', 'label': 'Checks', 'cwd': '{{inputs.workspace}}', 'commands': ['git diff --check'] },
      { 'kind': 'agent', 'id': 'review', 'label': 'Review', 'harness': 'dsh', 'prompt': 'Review the fix for {{inputs.bug}}. Build report: {{blocks.build.output}}. Checks: {{blocks.checks.output}}. Read src/ and assess the fix independently. Start with REFUTED if changes are required; otherwise start with APPROVED.', 'scope': { 'cwd': '{{inputs.workspace}}', 'read': ['.'], 'write': [], 'commands': [], 'web': false, 'sandbox': 'read-only' } },
      { 'kind': 'gate', 'id': 'you', 'label': 'You decide' },
    ],
    'edges': [
      { 'from': 'map', 'to': 'build', 'kind': 'next' },
      { 'from': 'build', 'to': 'checks', 'kind': 'next' },
      { 'from': 'checks', 'to': 'review', 'kind': 'next' },
      { 'from': 'review', 'to': 'you', 'kind': 'next' },
      { 'from': 'review', 'to': 'build', 'kind': 'loop', 'on': 'refuted', 'maxRounds': 2 },
    ],
    'limits': { 'maxMinutes': 30, 'maxHops': 12, 'maxCostTokens': 200000 },
  }),
  flowSchema.parse({
    'id': 'company-research',
    'name': 'Company research',
    'version': 2,
    'inputs': [{ 'name': 'workspace', 'type': 'path', 'required': true }, { 'name': 'company', 'type': 'string' }],
    'blocks': [
      { 'kind': 'agent', 'id': 'research', 'label': 'Research independently', 'harness': 'dsh', 'prompt': 'Research {{inputs.company}} using web sources. Cite URLs, distinguish claims from verified facts, and write a uniquely named note under notes/. Return your findings and note path.', 'scope': { 'cwd': '{{inputs.workspace}}', 'read': ['.'], 'write': ['notes'], 'commands': [], 'web': true, 'sandbox': 'workspace-write' }, 'copies': 3, 'concurrency': 2 },
      { 'kind': 'agent', 'id': 'merge', 'label': 'Merge research', 'harness': 'dsh', 'prompt': 'Merge these independent findings about {{inputs.company}} into notes/summary.md. Preserve citations and disagreements: {{blocks.research.output}}', 'scope': { 'cwd': '{{inputs.workspace}}', 'read': ['.'], 'write': ['notes'], 'commands': [], 'web': false, 'sandbox': 'workspace-write' } },
      { 'kind': 'checks', 'id': 'checks', 'label': 'Check summary', 'cwd': '{{inputs.workspace}}', 'commands': ['test -s notes/summary.md'] },
    ],
    'edges': [{ 'from': 'research', 'to': 'merge', 'kind': 'next' }, { 'from': 'merge', 'to': 'checks', 'kind': 'next' }],
    'limits': { 'maxMinutes': 30, 'maxHops': 8, 'maxCostTokens': 100000 },
  }),
]
