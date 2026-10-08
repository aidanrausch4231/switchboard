---
description: "Add Switchboard to a web-derived profile with session upload, package inventory reporting, and Session telemetry disabled by default."
kind: "package-bundle"
---

# @switchboard/bundle

English | [中文](README.zh.md)

## Summary

Add a Switchboard sidebar page and Host connectivity check to a web-derived profile. This optional bundle disables DeepSeek session-log upload, DeepSeek package-inventory reporting, and OpenTelemetry Session telemetry in the composed configuration. It does not prevent later profile or command-line overrides.

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

Run from the built repository root. The explicit home keeps this development profile separate from `~/.dsh`; the first command creates the profile without starting its server. Skip that command if the profile already exists.

```sh
export DSH_HOME="$HOME/.switchboard-dev/dsh-home"
pnpm dsh --profile switchboard --from-default-profile web --dump-config
pnpm dsh plugin --profile switchboard add "$PWD/packages/bundle"
pnpm dsh --profile switchboard --dump-config
pnpm dsh --profile switchboard --host 127.0.0.1 --port 3091 --no-open
```

Open the authenticated URL printed by the last command. Click **Switchboard** to see **Connected**, a successful ping, and three workspace placeholders. Stop the server with Ctrl-C. `--dump-config` shows `switchboard-core`, `switchboard-ui`, `session-log-deepseek.config.enabled: false`, `plugin-package-inventory-deepseek.config.enabled: false`, and `session-telemetry-otel.disabled: true`.

The bundle also mounts the [Council](../council/README.md) and a dedicated `claude-code-council` provider configured with `permissionMode: plan`. Open **Council** for the [chamber UI](../ui/README.md); native Codex seats remain unavailable.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The manifest's `dsh.bundle.patch` points at [cordis.patch.yml](cordis.patch.yml). The composer inserts the [core](../core/README.md) and [UI](../ui/README.md) rows and overrides the three existing privacy rows by id. The package declares inserted plugins as dependencies so profile resolution can find their bare package names. Profile, home, and command-line patch layers can override these defaults.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Switchboard packages](../../README.md) — package map and license.

<a id="model-experience"></a>
## Model Experience

None, as the bundle only composes plugins; the Council package owns its model requests.

#### KV Cache effect

None for composition itself; Council calls have the token effects documented by their owner.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **Web-derived profiles** — the UI requires the web composition's transport, locale, layout, and slot owners.
- **Defaults, not a network firewall** — these three overrides do not disable every upstream network feature, and later configuration layers may re-enable them.

<a id="dev-note"></a>
### Dev Note

None.
