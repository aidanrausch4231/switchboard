---
description: "Configure turn-local DeepSeek to OpenRouter fallback after native request retries. Inspect actual provider attribution in the session log."
kind: "package-reference"
---

# @switchboard/fallback

English | [中文](README.zh.md)

## Summary

Continue an agent turn through OpenRouter when DeepSeek exhausts native recovery for a transient failure. The next turn tries the primary route again unless the user selects another model. Fallback can send conversation history to another provider and incur charges there; quota-triggered switching requires explicit opt-in.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this Host plugin beside the agent registry, loop, native retry plugin, and configured provider adapters. The package does not register adapters or provision credentials; configure OpenRouter through dsh's `llm-pi-ai` package.

```yaml
- name: '@switchboard/fallback'
  config:
    enabled: true
    primaryProviders: [deepseek-official]
    fallbackProvider: openrouter
    modelMap:
      deepseek-v4-flash: deepseek/deepseek-v4-flash
      deepseek-v4-pro: deepseek/deepseek-v4-pro
    fallbackOnQuota: false
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Install fallback listeners. |
| `primaryProviders` | `['deepseek-official']` | Eligible source provider routes. |
| `fallbackProvider` | `'openrouter'` | Registered replacement route. |
| `modelMap` | The two entries above | Exact source-to-target model ids; an unmapped model never falls back. |
| `fallbackOnQuota` | `false` | Also permit fallback for `QUOTA`. |

Native recovery runs first. A downstream retry decision wins, including an unbounded native retry policy. Terminal `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, and `EMPTY_RESPONSE` failures permit one fallback per agent turn. `AUTH`, `INVALID_REQUEST`, `ABORTED`, and `CONTEXT_WINDOW_EXCEEDED` never trigger fallback. Replacement failures receive their own provider's native retry policy but cannot trigger a second fallback in the same turn.

Fallback removes `stop` and `reasoningEffort`: pi-ai rejects stop sequences, and effort ids belong to the exact model. Temperature and explicit output-token limits remain intact. The next turn restores primary stop sequences only if the final route is the original primary; an explicit model selection retains precedence.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [plugin](src/index.ts) wraps `agent/request-error` and `agent/request`. A pending decision replaces the selected route for the rest of the turn. A restoration listener runs inside the existing model-selection listener on the next turn, so selection retains precedence. Pending state and listeners are removed on agent or plugin disposal.

The core logs the replacement request header and attributes the assistant response to its actual provider and model. The plugin emits the process-local `switchboard/fallback` Cordis event and an info log when it schedules fallback; it appends no custom session event. The event carries the session id, turn, step, source and destination routes, and failure code. It announces a scheduled attempt, not successful recovery. A synchronous notification observer failure is logged and cannot block the replacement request.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration


-----

<a id="model-experience"></a>
## Model Experience

### Replacement request

#### What the model sees

The replacement provider receives the loop's reconstructed conversation history and tools. Failed `assistant/attempt` events remain log-only; this plugin adds no prompt text or tool definitions. During an active fallback turn, `agent/pre-step` removes model-selection notices when the effective route matches the previous request, preserving all other messages. The next turn's real switch back to the primary retains its notice.

#### Token effect

Fallback repeats the request at another provider, consuming that provider's input and output tokens in addition to any usage from failed primary attempts.

#### KV Cache effect

Changing provider or model does not preserve provider-side cache reuse. Restoring the primary route on a later turn also changes the request route; cache availability remains provider-owned.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Fallback state is live-agent-local, not persisted. Restarting, resuming, or unloading the plugin does not restore a previously remembered primary route; callers must supply their desired route when creating an agent.
- Direct `ctx.llm.stream()` calls, including auxiliary title or compaction calls, do not use agent recovery and receive no fallback.
- Provider registration, credentials, model availability, image compatibility, and output-token capacity remain deployment responsibilities. Fake-adapter tests do not verify live OpenRouter availability.
- Model-selection listeners must be installed before recovery begins, as upstream agent setup does. A later routing wrapper must preserve the plugin's turn-local replacement.
- The app event and info log are not durable fallback-reason records or a UI notification. Durable attribution is provided by core request headers and assistant messages.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
