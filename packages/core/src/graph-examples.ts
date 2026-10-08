/** Starter graphs mirror the JSON examples; memory paths are bound at first seed. */
import { join } from 'node:path'
import type { Graph } from './graph-types.ts'
import { graphSchema } from './graph-schema.ts'

const examples = [
  {
    'id': 'billing',
    'name': 'Billing',
    'description': 'Invoices, billing questions, and read-only account research',
    'color': '#b48bf5',
    'lead': {
      'harness': 'dsh',
      'provider': 'deepseek-official',
      'model': 'deepseek-v4-flash',
      'memoryDir': '/switchboard-memory/billing',
      'instructions': 'Read memory first. Keep notes concise. Never perform production writes; bounce uncertain requests. Dispatch only when the card supplies a workspace.',
    },
    'nodes': [
      {
        'id': 'billing-reader',
        'kind': 'agent',
        'description': 'Read local billing documents. Input: task (string).',
        'agent': {
          'id': 'billing-read',
          'kind': 'agent',
          'label': 'Billing reader',
          'harness': 'dsh',
          'prompt': 'Read billing documents for {{inputs.task}}. Do not change files or contact production.',
          'scope': {
            'cwd': '{{inputs.workspace}}',
            'read': [
              '.',
            ],
            'write': [],
            'commands': [],
            'web': false,
            'sandbox': 'read-only',
          },
        },
      },
    ],
    'edges': [
      'research',
    ],
    'rules': {
      'maxCostTokens': 100000,
      'prodWrites': 'never',
    },
  },
  {
    'id': 'code',
    'name': 'Code',
    'description': 'Bugs, code changes, and independent review',
    'color': '#6ea8fe',
    'lead': {
      'harness': 'dsh',
      'provider': 'deepseek-official',
      'model': 'deepseek-v4-flash',
      'memoryDir': '/switchboard-memory/code',
      'instructions': 'Read memory first. Keep notes concise. Never perform production writes; bounce uncertain requests. Dispatch only when the card supplies a workspace.',
    },
    'nodes': [
      {
        'id': 'fix-bug',
        'kind': 'flow',
        'flowId': 'fix-bug-with-review',
        'description': 'Fix a bug with independent review. Input: bug (string).',
      },
    ],
    'edges': [
      'research',
    ],
    'rules': {
      'maxCostTokens': 100000,
      'prodWrites': 'never',
    },
  },
  {
    'id': 'research',
    'name': 'Research',
    'description': 'Company research and evidence gathering',
    'color': '#62c9ab',
    'lead': {
      'harness': 'dsh',
      'provider': 'deepseek-official',
      'model': 'deepseek-v4-flash',
      'memoryDir': '/switchboard-memory/research',
      'instructions': 'Read memory first. Keep notes concise. Never perform production writes; bounce uncertain requests. Dispatch only when the card supplies a workspace.',
    },
    'nodes': [
      {
        'id': 'research-company',
        'kind': 'flow',
        'flowId': 'company-research',
        'description': 'Research a company and merge sources. Input: company (string).',
      },
    ],
    'edges': [],
    'rules': {
      'maxCostTokens': 100000,
      'prodWrites': 'never',
    },
  },
]

/** Resolve example memory directories without creating them or launching work.
 * @param root - deployment-owned memory parent.
 * @returns three validated starter graphs.
 */
export function exampleGraphs(root: string): Graph[] {
  return examples.map(graph => graphSchema.parse({ ...graph, lead: { ...graph.lead, memoryDir: join(root, graph.id) } }))
}
