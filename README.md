# Switchboard

A local, MIT-licensed dsh plugin workspace: visual **Flows**, **Automations**, domain **Graphs**, read-only **Council**, **Subscriptions**, voice controls, and an optional provider-fallback plugin. No fork changes are needed for Switchboard itself.

Tested with clean dsh `5badb15009` (`0.2.1-alpha.1`). dsh's public APIs are pre-stable: peer versions are deliberately pinned, and upgrades need the smoke test below. Node 22.23+ and pnpm 11.7.0 are required. Run heavy commands **sequentially**.

## Layout

| Path | Owns |
| --- | --- |
| `packages/core` | Host APIs, Flows, Automations, Graphs, subscription conversations and voice |
| `packages/council` | Read-only deliberation and forced-plan Claude wrapper |
| `packages/fallback` | Optional turn-local DeepSeek → OpenRouter fallback |
| `packages/ui` | Browser pages, subscription card, run dock and chat cards |
| `packages/bundle` | Profile registration and privacy defaults |
| `build` | Owned browser factory/CSS build and exported Typert generator integration |
| `tests/snapshots` | Owned historical Flow/Council replay inputs |
| `scripts` | Adapter gate, upgrade smoke, patched-runtime preparation, user launcher |

Every package has one dsh import boundary: `src/dsh.ts` (UI: `src/client/dsh.ts`). Build tooling uses `build/dsh.ts`. `pnpm check` enforces this, including tests. Browser tests execute built public dsh factories, not upstream source. Typert generation stages public declarations in ignored `.typert/`; no upstream build preset or test harness source is imported.

Runtime Remote names and storage domains stay compatible. Council requests/answers now live in `switchboard_council.calls`, keyed by Council session id. Router calls live in `switchboard.router_calls`, keyed by call session id and carrying the graph card id when applicable. Full prompts, answers, failures and usage are retained; card timelines and routing logs remain unchanged. dsh Sessions contain only dsh events. **Old fork logs containing required custom events are not migrated**; do not point stock dsh at those old profiles. The headless regression replays both owned scenarios, routes a graph card and reopens every newly produced log using dsh without Switchboard installed.

Claude Council seats must use `@switchboard/council/claude-code`: the wrapper forces `permissionMode: plan`, then binds the public provider identity. It never reads provider-private configuration. Codex native seats remain disabled pending read-only support.

## Build and install on stock dsh

Keep a clean checkout beside this repository at `../dsh-upstream`. Development manifests link its **built public packages** and use workspace links between Switchboard packages.

```sh
(cd ../dsh-upstream && pnpm install --frozen-lockfile && RAYON_NUM_THREADS=2 pnpm run build)
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run build
```

Install the local bundle through the supported profile manager, not by editing dsh:

```sh
PLUGIN="$PWD"
export DSH_HOME="$(mktemp -d /tmp/switchboard-profile.XXXXXX)"
cd ../dsh-upstream
pnpm dsh --profile switchboard --from-default-profile web --dump-config >/dev/null
pnpm dsh plugin --profile switchboard add "$PLUGIN/packages/bundle"
pnpm dsh --profile switchboard --host 127.0.0.1 --port 0 --no-open
```

The bundle disables DeepSeek session logging, package inventory and OTEL telemetry. Fallback is a separate opt-in plugin; see `packages/fallback/README.md`. Voice defaults to browser STT and no TTS; browser speech may use the browser vendor's service. Model calls and real OAuth require separately configured accounts; tests use scripted providers and mocked OAuth only.

## ChatGPT sign-in: optional patched runtime

Stock dsh's pi-ai 0.87 cannot complete the new ChatGPT flow. Its Subscriptions card displays **“ChatGPT needs pi-ai >= 1.0”** and disables sign-in. Other Switchboard features do not require the patch.

`patches/dsh/0001-pi-ai-1.0.4.patch` exports the llm-pi-ai upgrade, its tests, license notice, pnpm patch and lockfile delta relative to the tested dsh base. It does not patch Session vocabulary or add Switchboard to dsh. To prepare a separate runtime without modifying the clean checkout:

```sh
scripts/prepare-dsh.sh ../dsh-upstream ../dsh-runtime
scripts/upgrade-smoke.sh ../dsh-runtime
```

The preparation script requires a clean source and a nonexistent output directory. It creates a detached worktree, applies local patches, installs with the frozen lockfile and builds. The runtime's patch is intentionally uncommitted; `dsh-upstream` remains pristine. No fetch, pull or push is performed by either script.

For the user's persistent profile, after building this plugin:

```sh
scripts/run-web.sh --host 127.0.0.1 --port 7346 --no-open
```

This installs the bundle into the user's **switchboard** profile and launches `../dsh-runtime`. It defaults to the real dsh home: **acceptance never runs this command against `~/.dsh`**. Set `DSH_HOME` for isolated use; `DSH_RUNTIME` can override the launcher/browser-test runtime. Only the owner should run the persistent-profile command.

## Upgrade dsh

In the clean clone, when authorized to access the remote, `git pull --ff-only` and `pnpm install --frozen-lockfile`; then from this repository:

```sh
scripts/upgrade-smoke.sh ../dsh-upstream
```

The smoke builds that exact dsh, temporarily retargets ignored dependency symlinks, forces a fresh plugin typecheck, checks adapters, builds artifacts, runs **all tests**, and explicitly runs the keyless Flow + graph-card + Council + clean-Session-reopen acceptance. Links are restored on exit. Do not run another plugin build/test concurrently. Investigate failures at the package adapters before widening peer versions. To upgrade the optional runtime, prepare a new output worktree and smoke it. Preparation records the source revision and SHA-256 patch fingerprints in `.switchboard-prepare`, stages the exact patched tree, and resumes/rebuilds a matching owned output after interrupted install/build. It refuses unrelated outputs, changed revisions/patches, and unexpected tracked or untracked edits (ignored build artifacts are allowed). Do not remove the marker or edit/stage runtime files; use a new output for a different source/patch set.

Installed UI acceptance (Playwright Chromium required):

```sh
node packages/ui/tests/installed-web-smoke.mjs /tmp/switchboard-shots
node packages/ui/tests/subscriptions-web-smoke.mjs /tmp/switchboard-shots
```

Both create isolated homes, install via `dsh plugin`, use real Host/Remote/browser composition with keyless fixtures, emit `x1-*.png`, and stop their own servers. The subscription smoke checks that mocked grants, pasted codes and device/exchange secrets never appear in HTTP responses, Remote frames, Host logs or rendered HTML. Sign-in URLs admit only provider-specific public parameters. Cancel/dispose waits for already-queued credential writes to settle before releasing the sign-in slot (an admitted grant is not rolled back). No real account entitlement or inference is claimed. Inspect screenshots as well as exit status; do not publish `web/dist`.
