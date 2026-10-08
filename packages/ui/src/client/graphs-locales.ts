/** Locale-owned Graphs, board, and editor copy. */
export const en = {
  title: 'Graphs', intro: 'One inbox. The right lead. Every step on the board.',
  top: 'Top level · Jev', board: 'Board', routing: 'Routing log', timeline: 'Card timeline',
  inbox: 'Inboxes', chatVoice: 'Chat + voice', manual: 'Manual cards', failedRuns: 'Failed runs', webhook: 'Webhooks',
  jev: 'Jev', router: 'router', council: 'Council', you: 'You', councilHint: 'Read-only · quick mode', youHint: 'Risky or unsure',
  graphSummary: 'Lead + {count} nodes', rules: 'Rules on every card', confidenceRule: 'Below 70% confidence → You',
  hopsRule: '5 hops across leads and nodes · token cap per card', productionRule: 'Production writes: never', fallbackRule: 'Jev unavailable → DeepSeek Flash',
  new: 'New', routingState: 'Routing', running: 'Running', 'needs-you': 'Needs you', done: 'Done', failed: 'Failed',
  newCard: 'New card', cardTitle: 'Title', cardBody: 'What needs doing?', workspace: 'Workspace path',
  workspaceHint: 'Required to dispatch nodes; routing can run without it.', create: 'Send to inbox',
  approve: 'Approve', reject: 'Reject', reroute: 'Reroute', destination: 'Destination', approveHint: 'Approve records human resolution; it does not execute production writes.',
  noCards: 'No cards yet. Add a need to the inbox.', noRoutes: 'Routing decisions will appear here.', noTimeline: 'Select a card to inspect its timeline.',
  tokens: '{count} tokens', usageUnavailable: 'Usage unavailable', hops: '{count} / 5 hops', confidence: '{value}%',
  newGraph: 'New graph', editGraph: 'Edit graph', save: 'Save graph', cancel: 'Cancel', deleteGraph: 'Delete graph',
  graphId: 'Graph id', name: 'Name', description: 'Domain description', color: 'Graph color', lead: 'Lead agent',
  harness: 'Harness', dsh: 'dsh', claude: 'Claude Code (scoped tools unavailable)', provider: 'Provider', model: 'Model',
  memory: 'Memory folder', instructions: 'Lead instructions', nodes: 'Nodes', addFlow: 'Add saved flow', flow: 'Saved flow',
  addAgent: 'Add agent', remove: 'Remove', nodeId: 'Node id', nodeDescription: 'Node description',
  agentSpec: 'Agent block JSON (Flow scope)', edges: 'Ask other leads', tokenCap: 'Token cap per card',
  memoryHint: 'Markdown notes · read and append only', fromJev: 'From Jev ↓ · bounce back ↑',
  readOnly: 'Read only', webOn: 'Web on', webOff: 'Web off', scope: 'Scope',
  loadError: 'Could not load Graphs. Retry to reconnect.', actionError: 'Could not save this change.', retry: 'Retry', loading: 'Loading Graphs',
  preview: 'Test router', previewHint: 'Preview consumes model tokens but creates no card.',
} satisfies Record<string, string>
/** Keys accepted by Graphs translators. */
export type GraphsKey = keyof typeof en
