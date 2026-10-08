---
description: "Save scoped Flows, validate launch requirements, and follow durable runs with human approval checkpoints."
kind: "package-reference"
---

# @switchboard/core

English | [中文](README.zh.md)

## Summary

Save recipes that combine scoped agents, verification commands, and human approval. Preview launch errors before starting work, follow durable progress, and cancel owned agents and processes. Recipes support concurrent copies and bounded review loops. Each run retains its recipe and inputs so later edits cannot change active work.

Check browser connectivity and use optional OpenAI transcription and spoken replies. Browser recognition is the default and needs no OpenAI key; spoken replies default to off. OpenAI requests use the Host's `OPENAI_API_KEY`, which never enters Remote responses.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use the [Switchboard bundle](../bundle/README.md) in a web-derived profile. Its patch mounts `switchboard-core`; the existing UI mount installs the generated Remote contribution. Storage uses the `switchboard` domain through the configured storage backend. Running agents additionally requires agent presets, agents, tools, system prompts, and an LLM adapter; checks and Git auditing require a shell executor.

| Field | Default | Meaning |
|---|---|---|
| `maxAgents` | `64` | Estimated and actual agent launch ceiling per run. |
| `automationPollMs` | `15000` | Server calendar polling interval, 1000–60000 ms. |
| `commandTimeoutMs` | `120000` | Deadline for each check command, Git audit, and Host shutdown wait. |
| `outputBytes` | `32768` | Retained UTF-8 output bytes per attempt and combined block; also the Git audit output budget. |
| `maxRunMinutes` | `60` | Run deadline including human waiting time; recipe limits can shorten it. |
| `agentPreset` | composition default | Standing composition mounted for each root agent. |
| `routerProvider` / `routerModel` | `openrouter` / `typesafe/jev-router` | Jev route; the model id is unverified and catalog failure is reported explicitly. |
| `fallbackRouterProvider` / `fallbackRouterModel` | `deepseek-official` / `deepseek-v4-flash` | Tool-less fallback after pre-request availability failure or metered transport/JSON failure. |
| `productionTerms` / `productionWriteTerms` | `prod, production` / `write, writes, migrate, migration, delete, deploy, update, insert, drop, apply` | Case-insensitive whole-word rule; one term from each list routes to You. |
| `graphMaxCostTokens` / `graphTimeoutMs` | `100000` / `600000` | Cumulative card token ceiling and active execution deadline. |
| `graphMemoryRoot` | `$DSH_HOME/switchboard/memory` (or `~/.dsh/switchboard/memory`) | Memory parent for the three starter graphs. |

Graphs use the independent `switchboard_graphs` storage domain. Empty graph stores receive [Billing](examples/graphs/billing.json), [Code](examples/graphs/code.json), and [Research](examples/graphs/research.json). The Remote offers `graphs.list/get/save/delete/memory`, `cards.create/list/get/approve/reject/reroute`, `router.test`, and the undotted `followCards` stream. Card creation accepts `title`, `body`, `source`, and an optional absolute `workspace`; dispatch requires that workspace and supplies it to a Flow's declared `workspace` input. `graphs.memory` returns bounded Markdown notes and creates the folder if absent; it never invokes a model. Graph Flow snapshots bind `{{inputs.workspace}}` cwd templates before preflight; the two original example flows also bind their `/workspace` placeholder without changing the saved recipe. Node cwd targets must resolve inside the canonical card workspace. Each launch rechecks the original path bindings and executes with the retained canonical cwd.

Jev receives the card and domain descriptions, with one strict-JSON parse retry per route. Unknown targets and confidence below 0.70 go to You. Production-write rules precede both model and explicit human routing; approval records human resolution, never authorizes a production write. A lead can read flat Markdown memory, append notes, dispatch listed nodes, ask adjacent leads, bounce to Jev, or finish. Dispatch/ask/bounce share five hops; cumulative tokens and the lowest visited graph cap survive reroutes. Every settled dsh request must report usage; a missing counter stops tools and further inference and requires You. Router errors, incomplete answers, and missing finishes without usage also prohibit fallback. Graph logging and cleanup retain missing-usage and budget errors rather than allowing fallback. Observed card usage is durably checkpointed before further work, including memory operations and Council chair retries. Failures, exhausted budgets, and interrupted work also require You. Failed node runs and human Flow gates are not replayed automatically.

An empty flow store is seeded at Host startup with [fix-bug-with-review](examples/fix-bug-with-review.json) and [company-research](examples/company-research.json), also exported as `exampleFlows` in the published module. Startup migrates unchanged version-1 seeds to workspace-bound version-2 recipes; user edits and partial deletions are preserved. Supply the required `workspace` input as an existing absolute directory, select dsh models or configure the default model, and customize checks for that workspace. Inputs declare `name`, `type` (`string`, `number`, `boolean`, or `path`), optional `default`, and optional `required` (true unless explicitly false). Agent and check cwd values accept `{{inputs.workspace}}` with an optional relative subpath. Preflight resolves this binding through symlinks and requires every agent/check cwd to stay inside the canonical workspace; runs capture canonical cwd and workspace inputs. Missing descendants are checked against their nearest existing ancestor. Execution rechecks path targets before queueing, after checkpoints, and immediately before each agent or check command; changed targets fail the run. Other cwd templates and parent traversal are rejected. Scope paths name literal files or directories relative to cwd, not globs; commands must match exactly.

The authenticated `switchboard` Remote namespace exposes `flows.list/get/save/delete/validate/preflight` and `runs.start/get/list/cancel/approveGate` as dotted method keys, for example `ctx.remote.switchboard['flows.list']()`. The stream is named `followRuns`, because the current Typert stream decorator cannot rename methods to dotted keys. Calls use the normal Remote result envelope. `followRuns(runId)` sends a snapshot followed by durable replacement updates; slow readers coalesce updates while retaining the complete timeline. Disconnecting a subscriber does not cancel its run. `ping()` remains available.

Automations persist named schedules and a firing journal in the same storage domain. `automations.list/get/save/delete/setEnabled/runNow/stats` are dotted Remote keys. Save accepts editable fields (`id` optional for creation, `name`, `flowId`, primitive `inputs`, `schedule`, `enabled`); the Host owns timestamps. Cron uses five fields and an explicit IANA zone through MIT-licensed Croner. A daily `0 2 * * *` rule runs at 02:00 in that zone; Croner shifts missing spring times forward and uses the later fall-back occurrence. Manual schedules fire only through `runNow`, which also works while paused. Timer admission uses `ctx.interval` and needs the timer service, not an open browser or live Session.

Startup admits one catch-up run if any occurrence was missed since creation or the last firing. Automatic admission waits for successful Flow preflight, including agent, preset and provider availability. Scheduler preflight failures leave the journal unchanged; executor admission failures record a failed firing. Both retain the watermark and retry with a fixed `automationPollMs` backoff. Pausing or editing timing resets that watermark; paused time is not caught up on enable. Admitted runs and overlap skips advance it; rejected admissions do not. A queued, running or human-waiting predecessor prevents overlap and records `skipped`. Manual admission errors are recorded as failed firings. Deleting an automation removes its schedule and firing journal but retains its Flow runs without cancelling them. Stats default to 20 rows (maximum 100), newest first; the generated client requires both positional slots, so call `ctx.remote.switchboard['automations.stats'](id, undefined)` for that default. A `pending` statistics row is a reservation without a FlowRun; only queued, running or human-waiting rows can be followed. Columns follow the current Flow with historical-only blocks appended. Cells summarize the latest round across copies; a successful retry after failure/refutation is `recovered`.

Ordinary edges determine a stable topological execution order; independent blocks run serially, while `copies` and `concurrency` control parallel agents within a block. Each loop repeats the ordered target-to-source segment for at most `maxRounds` additional rounds. A final answer starting with `REFUTED` triggers a refuted loop, including when retained output is truncated. Output references use the latest completed output and expand to empty text before the first result, allowing a builder to receive the previous review. Denying a human gate fails the run; approving it continues execution. An exhausted matching loop fails rather than advancing to approval.

Flow agents use their preset's tools with native tool presentation, including when the preset selects PTC. Restrictions remove write tools when `write` is empty, shell when `commands` is empty, and web tools when `web` is false. Execution guards reject unlisted tools, paths, commands, background shell launches, cwd overrides, and sandbox escalation. Paths cannot contain `..` segments. Existing ancestors are resolved through symlinks, and the resulting target must stay inside a granted root and cwd. Git workspaces receive a porcelain-status audit plus non-following metadata snapshots; other directories use metadata snapshots. Snapshots include directory existence and permissions, but not directory timestamps. Outside-scope changes fail the run and are not reverted.

Use the [Switchboard bundle](../bundle/README.md) in a web-derived profile. Its patch mounts this plugin as `switchboard-core`. Speech settings on that row select defaults; the Voice page can override provider choices for the current browser session.

| Field | Default | Meaning |
|---|---|---|
| `sttProvider` | `browser` | Recognition: `browser` or `openai`. |
| `ttsProvider` | `off` | Reply speech: `off`, `browser`, or `openai`. |
| `transcriptionModel` | `gpt-4o-transcribe` | OpenAI recognition model; no automatic model fallback. |
| `speechModel` | `gpt-4o-mini-tts` | OpenAI synthesis model. |
| `speechVoice` | `alloy` | OpenAI synthesis voice. |
| `maxAudioBytes` | `10485760` | Audio limit, at most 10 MiB. |
| `maxDurationSeconds` | `60` | Browser hold-operation lifetime, at most 120 seconds. |
| `timeoutMs` | `45000` | OpenAI request deadline. |

The authenticated Remote exposes key presence, not its value. Transcription accepts bounded canonical base64 audio; synthesis accepts 1–4096 characters and returns bounded MP3 audio. HTTP 429 displays “OpenAI speech quota exceeded — switch to Browser in Voice settings”. Raw provider errors are not returned. Successful transcripts and audio are rejected if they contain the exact trimmed credential captured for that request, including when the environment changes while the request is pending.

Subscriptions expose presence-only status for ChatGPT, Claude Pro/Max, GitHub Copilot, Kimi, Meta and xAI. Sign-in runs the installed pi-ai OAuth flow through Host authorization; closing its stream cancels the conversation. Host cancellation and shutdown wait for queued credential writes; an admitted grant is retained, not rolled back. Cancellation during that wait prevents route enablement. Links with query parameters outside the provider's public authorization allow-list are withheld. After the grant commits, the adapter adds a missing catalog route through revision-fenced live profile settings, without `apiKeyEnv` or a restart. Existing route overrides are retained; an API-key reference must be removed in Models settings before using the subscription. Sign-out deletes the local grant, retains the route, and does not revoke the provider account. Signed in means a stored grant, not verified entitlement or token validity. The [subscription adapter](src/subscriptions-adapter.ts) contains all subscription calls into dsh; frames contain only links, user codes, fixed questions and safe status, never tokens, pasted answers or raw provider errors.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [Host service](src/index.ts) opens the versioned storage domain before accepting requests. The [executor](src/engine.ts) records checkpoints before broadcasting domain changes and owns cancellation until every child settles. The [runtime adapter](src/runtime.ts) composes a fresh root Session per copy, records sandbox and approval settings through their canonical setters, drives followup to idle, checks the durable turn outcome, and always disposes the handle. dsh token totals come from committed Assistant message/attempt usage, not duplicated live stream counters.

Saved runs retain attempts, truncated output, Session ids, usage when available, and an ordered timeline. Active work is not replayed after a crash: queued/running records become failed on recovery unless persisted cancellation intent makes them cancelled. Uncancelled human checkpoints survive orderly shutdown with their original deadlines: recovery fails overdue runs and restores waiting timers for the rest. Cancellation and approval reserve per-run transitions before persistence; an overlapping approval is rejected. Cancellation requested before shutdown remains cancelled, including at a human checkpoint. Shutdown drains pending transitions and child cleanup, rejecting if they exceed `commandTimeoutMs`; recovery finishes persisted cancellation intents without restoring approval. Flow deletion retains run records and their embedded recipes. [Schemas](src/storage.ts) reject invalid durable records.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Switchboard packages](../../README.md) — package map and license.

<a id="model-experience"></a>
## Model Experience

### Scoped agent requests

#### What the model sees

The optional tool runtime exposes `run_flow` with a saved recipe name and primitive inputs. It checks admission and returns a run id immediately; its durable result metadata lets the browser reconstruct the chat card. Only a direct user request should start a saved Flow, whose declared scopes may permit writes and commands. Layout positions are stored independently in `switchboard_layout`. Each dsh copy receives its rendered recipe prompt and only the permitted tool schemas. The scope section contains the recipe's JSON scope after `Flow step scope: `, followed by the fixed instructions below. Native providers receive the rendered task plus `Scope: ` and that JSON in their user prompt; their own configuration owns tool access and permissions.

##### Scope instructions

```markdown
Use only the listed paths and exact commands. A review that rejects the work must start its final answer with REFUTED.
```

#### Token effect

The `run_flow` schema adds prompt tokens when the tool is visible; results contain only the run identity and name, not the execution transcript. Router calls are tool-less. Exact requests and settled answers are retained in the `switchboard` domain's `router_calls` table, keyed by call session id and associated with the graph card id (previews have no card). These records are not written as custom dsh Session events or sent back to the router. Leads receive six scoped tools and domain instructions; node results and memory reads enter their normal Session tool history. Router previews consume tokens but create no card. Each lead invocation uses a fresh Session and reads persistent memory explicitly. Every agent copy and loop retry creates a separate model conversation. Template expansion includes the latest retained output, bounded by `outputBytes`; admission rejects prompts larger than 64 KiB both initially and after output expansion. Scope text and available tool schemas add request tokens beyond the user-prompt limit.

#### KV Cache effect

Copies use independent Sessions. Repeated deployment text may share a provider-managed prefix, but changing scope, permitted tools, inputs, or referenced output changes request tokens; the package makes no cache-reuse guarantee.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **Native providers** — `claude-code` and `codex` use configured named `ctx.subagents` providers (`provider` selects the instance). Per-call model overrides are rejected. Those providers cannot enforce per-call read/command/web/tool restrictions; preflight warns, and post-run writes are audited. Configure the named provider's native sandbox and permissions before enabling such recipes.
- **Usage** — absent attempt usage means unavailable, not zero cost. Run token totals include only observed dsh usage; Claude Code/Codex have no token accounting. Token caps stop subsequent work when committed usage reaches the cap and can overshoot by in-flight requests; they cannot bound unreported native usage.
- **Filesystem auditing** — post-run detection is not rollback or isolation. Concurrent external edits can fail an audit. Metadata snapshots do not detect transient create/delete activity between snapshots; operating-system sandbox enforcement still depends on the configured dsh execution providers. Checks are trusted Host commands rather than agent-scoped tools.
- **Automation admission** — the firing reservation commits before launch; the watermark advances only after executor admission or an overlap skip. Recovery consumes interrupted reservations, recording started admission when the run exists and failed admission otherwise, without replaying uncertain side effects; this is not exactly-once execution. Firings are retained without a size cap. One admission queue serializes preflight and edits; long preflight delays other schedules.
- **Durability** — interrupted side effects are never automatically retried. There is no multi-Host scheduler, run retention policy, or dollar-price estimate. The generated transport is flat; `followRuns` is the stream spelling rather than `runs.follow`.

- **Provider access** — OpenAI speech requires Host credentials and quota; a successful ping verifies neither. Real audio quality and provider availability require a live speech check.
- **Graph memory** — directory-anchored access requires Linux procfs. Reads and appends verify the authorized directory's canonical path and device/inode, reject replacement directories, and access notes through its open descriptor; unsupported hosts fail closed.
- **Graphs** — only dsh leads can receive the scoped orchestration tools. Claude Code leads fail explicitly; native nodes and native Council seats are excluded because they cannot enforce a card token cap. Graph rules and lexical production detection do not replace an operating-system sandbox or a read-only production credential. Council cards use quick mode with metered LLM seats. One card can overshoot its token cap by already-in-flight calls. The model catalog check does not verify credentials or remote availability.

<a id="dev-note"></a>
### Dev Note

None.
