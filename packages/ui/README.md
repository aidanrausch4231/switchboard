---
description: "Use voice, consult the Council, edit Flows, follow runs, and schedule Automations."
kind: "package-reference"
---

# @switchboard/ui

English | [中文](README.zh.md)

## Summary

Use push-to-talk in chat and **Voice** for spoken replies. Open **Council** to choose seats, ask questions, and read rulings. Open **Flows** to edit canvas recipes, configure scopes, and launch after preflight; follow progress and checkpoints in the Flow dock or chat cards. Open **Automations** to schedule saved Flows and inspect outcomes. **Graphs** routes cards to domain leads, Council, or You and shows their board and timeline. **Switchboard** checks Host connectivity and opens all five workspace pages; navigation, editing, and charts need no model credentials.

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

Use the [Switchboard bundle](../bundle/README.md) in a web-derived profile. The package has no configuration fields. Its Host row serves the built browser contribution; rebuild after changing browser code. Automations has English and Chinese dictionaries; the connectivity overview retains English copy.

The **Subscriptions** card appears on Home and its own sidebar page. Sign in to ChatGPT, Claude Pro/Max, GitHub Copilot, Kimi, Meta or xAI, choose a browser or headless method when offered, and open the link or copy the verification code. Paste a redirect/code only when asked; GitHub Copilot can first ask for an Enterprise domain. Keep the page open until completion; Cancel or leaving the page withdraws the login. Successful sign-in enables the provider's catalog models in the normal chat picker. A saved grant with failed route enablement offers **Enable models**; raw provider diagnostics are not displayed. Sign-out removes the local grant, not the provider account. Live entitlement and inference require a real account; browser tests use mocked OAuth exchanges.

Hold the chat microphone or Space outside an editor, then release to send a transcript through the normal composer. Browser recognition needs no OpenAI key; OpenAI recognition and synthesis use Host credentials.

Start with an empty draft and an open Session. Space targets the focused composer, or the active main Session when focus is outside a composer; an occupied draft never redirects capture to another Session. Each recording belongs to its initiating Session. Switching Sessions before transcription finishes discards the recording with a notice rather than submitting it. Escape, pointer cancellation, window blur, a hidden document, and owner unmount also discard pending capture; a changed draft prevents insertion and submission. Enter release ends a microphone hold even after Tab moves focus away. The final transcript remains visible on a draft conflict. Browser recognition shows partial text; OpenAI shows final text after release. Only newly completed turns speak their last assistant text, with fenced and indented code blocks removed, including blocks nested in quotes or lists; history, reasoning, failed turns, and intermediate messages stay silent. Switching Sessions or unmounting the playback's owning control stops speech and aborts pending synthesis; late responses cannot restart playback. Removing the last Voice control stops all playback.

Provider defaults and limits belong to [core](../core/README.md). Voice settings last until reload; they do not modify Host config. Browser speech may use the browser vendor's service. OpenAI receives audio for recognition or final prose for synthesis. Transcript history is browser memory only; submitted messages use ordinary Session persistence.

For the keyless browser check, install Chromium with `pnpm --filter @switchboard/ui exec playwright install chromium --only-shell`. With the documented profile running without a configured model key and its preview notice dismissed, set `DSH_URL` to the authenticated URL and run `node packages/ui/tests/web-smoke.mjs "$DSH_URL"` from the repository root. It checks the real Host ping and compares the page's accessibility output with `tests/expected/page.aria.txt`; an optional second argument saves a screenshot. With a blank **New Session** available and no OpenAI key, `node packages/ui/tests/voice-web-smoke.mjs "$DSH_URL"` checks speech settings, the composer microphone, and `tests/expected/voice.aria.txt` without capturing audio.

Open **Graphs** to create a card, supply its workspace path, inspect routing confidence and reasons, and follow New, Running, Needs you, and Done columns. Click a graph for its lead memory notes and folder, scoped nodes, and directed lead edges. Edit graph settings to select saved Flows or explicit agent-block JSON. Approve acknowledges human completion; Reroute retains cumulative budgets and production rules. Router preview may consume tokens but creates no card. Leaving the page detaches live updates without stopping work.

The keyless Graphs browser check uses a web-derived profile with the local bundle and `--patch packages/ui/tests/fixtures/graphs.patch.yml` before the web app flags. This overlay isolates domain storage under `$DSH_HOME/graphs-ui-smoke/storages` and replaces only the external model. Run `node packages/ui/tests/graphs-web-smoke.mjs "$DSH_URL" top.png inside.png` against its authenticated URL. The check restores Billing’s lead settings after exercising routing, memory, node dispatch, and production refusal.

Council requires the [Council engine](../council/README.md) and at least two available seats including the configured chair. Unavailable seats show their reason and cannot be selected. Cancel stops the selected session and displays its terminal snapshot even if reconnecting fails; leaving the page only detaches its stream. Retry reconnects to an authoritative snapshot. New question clears and focuses the question field. Ask follow-up prepares an editable new question containing the previous question and ruling; it does not send automatically.

The keyless Automations browser check uses a fresh web-derived `dsh` profile with the [bundle patch](../bundle/cordis.patch.yml), [fake-model overlay](../core/tests/fixtures/automation-web.overlay.yml), and [in-page picker overlay](tests/fixtures/pin-browse-picker.overlay.yml). The fixture stores domains under `$DSH_HOME/switchboard-automation-smoke/storages`, separate from other local profiles. Run `node packages/ui/tests/automations-web-smoke.mjs "$DSH_URL" /tmp/automations.png` to create a manual automation and execute three scripted Flow runs; append `existing` to verify the retained fixture without creating more runs. The test compares owner-local ARIA output and captures both themes. Its example replaces the shell check with model review, so it needs no native sandbox backend.

The Automations list shows Flow summaries, timing, enabled/paused/manual status and the last result. Select a row for the outcome strip, SVG duration chart and newest-first stop grid. The median includes completed runs only; active durations are elapsed time, while skips and rejected admission have zero duration. Bright green grid cells identify a recovered loop round, red cells identify failure, and the callout counts failed-run stop blocks. Refresh reads newly scheduled runs and reconnects selected active `followRuns` subscriptions. Ended or failed streams reconnect after a one-second delay; pending reservations poll until their FlowRun exists. Refresh requests coalesce behind in-flight reads without discarding their results; the next retry waits for those reads to settle. Selection changes and unmount abort subscriptions and clear retries. Failed reads retain existing data. Run now and enabling require successful preflight, with the first error shown beside the actions. The drawer previews preflight and checks again before saving; an invalid Flow can be saved only while paused. Declared inputs, including `workspace`, appear in the JSON editor and persist as ordinary input values. The drawer preserves failed drafts and traps/restores focus; deletion asks for confirmation and reports its result through an app-wide notice.

The Run inputs default `workspace` to the active Session's working directory. Without an active Session, enter an existing absolute directory explicitly. Validate shows structural and current preflight diagnostics together. Save disables Refresh and recipe switching until its writes settle. Tab and Enter select graph nodes and edges for inspector edits or deletion. Switching between nodes and edges retains the most recent selection.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [browser entry](src/client/index.ts) mounts the core and Council generated Remote contributions. Each presentation plugin registers into `sidebar.panellist` and keyed `main` through declaration-lifetime injection. The [Council page](src/client/CouncilPage.tsx) folds ordered stream events and reads the final snapshot for votes and chair usage. Switching sessions disposes the follower and ignores late reads. Surrounding controls use semantic tokens; the original CSS/SVG chamber has a fixed dark palette, reduced-motion support, and list-layout seats below 900px of chamber width.

The [browser entry](src/client/index.ts) mounts generated Remote methods. [Page and dock registrations](src/client/flows-presentation.ts) pass plain commands and framework-bound observable seats to components. XYFlow is privately bundled under MIT; CSS Modules use shared theme tokens. Recipe saves and editor placements are independent writes, and active runs retain their recipe snapshot. A reference-counted model shares `followRuns` observations across retries; closing a dock retains any card's subscription without cancelling execution. Gate progress uses the latest visit, including repeated round-zero records. Chat cards derive from persisted `run_flow` result metadata and follow the native completed-turn/tool disclosure controls.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Switchboard packages](../../README.md) — package map and license.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the normal Conversation composer, which submits final transcripts as user input, the [Council engine's model requests](../council/README.md#model-experience), and [core](../core/README.md#model-experience), which renders automation inputs into Flow prompts and logs them. The browser adds no independent model instructions.

#### KV Cache effect

Transcript submission appends normal user input; page navigation, partial transcripts, settings, playback, and ping results do not change chat model context. A submitted Council follow-up includes the previous question and ruling as visible editable text.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **Browser support** — Web Speech recognition and microphone capture depend on browser support, a secure context, permissions, and vendor availability. OpenAI recording has no partial transcript. Live audio and playback require a manual permission/device check.
- **Composer ownership** — Switchboard uses the single `conversation.input.activity` slot; do not mount another voice-input activity in the same profile. Existing drafts must be sent or cleared before a hold can begin. Submission failures remain owned by the normal composer.
- **Engine metadata** — seat roles are chair or adviser; the chair identity becomes available only after admission. The Host validates chair inclusion. In-progress reconnects show waiting until a fresh seat event; voting and chair token usage arrive with the final snapshot.
- **Accounting** — native seats show usage unavailable, never zero. LLM totals include answer, vote, and chair calls; incomplete accounting is labeled. No dollar estimate is displayed.
- **Workspace integration** — Flows and Automations editors are separate contributions. Graphs uses its own SVG canvas and requires an explicit card workspace path before dispatch. Chat/voice/webhook callers can create cards through the Remote API; automatic ingestion and Council’s Send to Graphs action are not installed.
- **English copy** — Chinese translations are not provided.
- **Automation run management** — Automations starts runs but does not resolve human checkpoints or cancel runs; use the Flow dock or core Remote API.
- **History** — charts show the latest 20 firings. A new timer firing requires Refresh to appear; the selected known active runs stream updates.

- **Session-owned dock** — opening a run switches to a Conversation, reusing a viewed run Session or creating an empty Session without a model turn. The sidebar has no group-header API, so Flows follows Switchboard as an adjacent entry.
- **Drafts** — unsaved edits are local to the mounted page. Switching saved flows asks for confirmation; leaving the page discards drafts. Recipe inputs and execution limits are preserved but not authored in this editor.
- **Independent placement** — layouts live in the separate `switchboard_layout` domain. Saving a layout can fail after the recipe succeeds; the draft stays dirty for retry. Run graphs auto-layout the captured recipe rather than following later placement edits.
- **Keyless browser evidence** — with `DSH_HOME` set to a disposable initialized Switchboard home, `node packages/ui/tests/flows-web-smoke.mjs /tmp/switchboard-shots` launches the real profile, substitutes a scripted model, compares owner-local ARIA, and captures both themes. Its preview replaces the example's shell checks with a scripted agent; it does not test shell execution. The fixture retains local Sessions and runs for inspection.

<a id="dev-note"></a>
### Dev Note

None.
