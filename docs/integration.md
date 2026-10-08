# Integration and validation

## Supported source baseline

The initial client targets Hermes Agent revision
`e1fdf003a668f97bf5a53d7675c1e70b1dcfec34`, inspected on 2026-10-05.
The [handoff](implementation-handoff.md) links the authoritative session routes,
authentication handlers, gateway contracts, and reusable TypeScript client.
The implementation also checks `tui_gateway/methods_session.py`,
`tui_gateway/methods_prompt.py`, and `apps/shared/src/json-rpc-channel.ts` at
that revision. The shared code is MIT licensed. Its desktop client includes
registry, replay, and renderer integration that Agora does not need; Agora uses
a small independent browser transport and narrowed contract types, with upstream
attribution in `THIRD_PARTY_NOTICES.md`.

The supplied endpoint is `https://hermes-manage.vjcbs.be`. Its public status was
checked on 2026-10-05: authentication is required, cookie and `native_pkce` flows
are advertised, and the provider is self-hosted OIDC. Its exact Hermes revision
is unverified. Source inspection and synthetic tests do not establish successful
authenticated live login or chat. Recheck contracts against another revision.

## Laptop connection

Set `HERMES_ENDPOINT` in `.env.local`, then run `agora-dev` or build and run
`agora-start`. The local URL is `http://127.0.0.1:5173/`. The endpoint is a
runtime setting for `agora-start`, so changing servers does not require rebuilding
assets. Restart the process to apply it. Remote endpoints require HTTPS; HTTP is
allowed for loopback Hermes test installations. URL path prefixes are preserved.

`server/native-session.ts` implements the upstream native PKCE contract verified
in `hermes_cli/dashboard_auth/routes.py`. `/login` creates a fresh S256 verifier
and state, then navigates the browser to Hermes’s `/auth/native/authorize`.
Hermes owns provider selection and OIDC. Its loopback callback returns a one-time
code; the local service validates state, browser binding, origin, and expiry,
then exchanges it at `/auth/native/token`. The browser receives only an opaque
HttpOnly, SameSite=Lax session cookie. Tokens remain in process memory and are
rotated through `/auth/native/refresh`; concurrent refreshes share one request.

`server/bridge.ts` forwards only the chat client’s status, identity, session, and
history APIs. It replaces browser credentials with the native bearer token,
rejects upstream redirects, and never forwards upstream cookies. Each WebSocket
attempt mints a fresh ticket and connects using the documented subprotocols.
The upstream socket is a native connection without a browser Origin, matching
Hermes’s native-client policy; TLS verification remains enabled. Frames are
forwarded unchanged, including readiness, requests, and replies.

The service binds loopback and validates Host and Origin to prevent foreign
websites from using its authenticated connection. Mutations and WebSocket
upgrades require the local Origin. The callback instead requires the pending
browser cookie and unpredictable state. No permissive CORS headers are added.
Only GETs and ticket minting can retry after a definitive HTTP 401; session
mutations and chat frames are never replayed automatically.

Local logout drops the memory-held grant and closes both ends of its sockets.
Hermes exposes no native-token logout endpoint in the inspected contract; this
does not revoke provider SSO or log out the remote dashboard. Restarting the
local service requires signing in again. Tokens are not saved to disk or browser
storage. This service is a transport/auth adapter, with no agent runner,
transcript database, or Hermes filesystem access. A future desktop shell can
replace the loopback transport without changing the chat state machine.

## Hosted Node bridge

> [!WARNING]
> **This requires a Hermes build change allowing an exact HTTPS native-broker
> callback.** Unmodified Hermes on the documented revision accepts loopback
> callbacks only. Agora does not ship or apply that patch.

Set `AGORA_PUBLIC_ORIGIN=https://agora.example.com` alongside `HERMES_ENDPOINT`,
then build and run `agora-start`, or set `services.agora.publicOrigin` on NixOS.
The Node service remains on `127.0.0.1`; an HTTPS reverse proxy forwards the whole
application, preserving Host and browser Origin. See [the deployment examples](nix.md#public-hosting-with-the-node-bridge).

Login uses the same native broker as laptop mode, with the configured public
`/auth/native/callback`. Hermes's OIDC callback remains on its own domain;
the patched broker redirects to Agora with a one-time code and state. The Node
service checks browser binding/state/expiry and exchanges with PKCE. It keeps
per-browser tokens in memory, refreshes them, and performs authenticated HTTP
and ticket-based WebSocket forwarding. Browser code sees only an opaque session
cookie. Hosted cookies use `__Host-` names, Secure, HttpOnly, SameSite=Lax, and
Path=/; laptop cookies retain their existing names and HTTP behavior.

Host validation uses the configured origin for all HTTP routes, including static
files. Mutations and WebSockets require its exact Origin. Forwarded headers do
not choose the public origin or callback. The callback accepts the expected
cross-site browser return only with a pending login cookie and valid state/code;
replays are rejected. API/auth routes outside the bridge allowlist return errors
rather than the SPA. No arbitrary upstream target can be selected by a request.

The client recognizes both `local` and `hosted` bridge metadata and lets the
bridge mint upstream WebSocket tickets. It continues using same-origin browser
HTTP/WS connections. A service restart requires login again. Only one process
is supported; in-memory state is not shared between replicas. Existing retry
and ambiguous-send rules apply unchanged. No Hermes CORS, Host/Origin, or cookie
policy changes are required beyond the independently maintained callback patch.

## Browser and server boundary

`src/hermes/api.ts` owns same-origin cookie-authenticated HTTP requests and profile-aware
session operations. `gateway.ts` handles JSON-RPC correlation, coalesced
newline-delimited notifications, server requests, timeouts, and the advertised
15-second heartbeat with a 45-second liveness deadline. It waits for
`gateway.ready` before accepting calls. Each authenticated connection gets a
fresh single-use ticket through `/api/auth/ws-ticket` (by the local service in
laptop mode), sent in the supported
WebSocket subprotocol, never in a URL or browser storage.

`chat.ts` owns selection, reconnect backoff, pending interactions, and action
state. `transcript.ts` normalizes REST display projections and merges pages by
durable row IDs. Vue components handle presentation and explicit user choices.
Session create and resume RPCs sent over `/api/ws` set `source: "desktop"` to
identify Agora as a graphical client to Hermes, including during recovery.
The presentation groups assistant text and tool results into one turn, skipping
empty stored assistant rows. Consecutive tool results share an expandable group
with tool names and safely rendered plain-text output. During a turn, `tool.start`
and `tool.complete` populate that same group, matched by `tool_id`. Its collapsed
header shows the running count and current command or path; expanding it shows
arguments, results, summaries, and reported durations. Concurrent calls retain
independent status. Once the turn completes, REST history replaces these temporary
rows with the stored transcript. Tool activity is kept in memory only.
Grouping preserves order
and user-turn boundaries without changing the underlying transcript or row IDs.
The URL carries the durable stored ID; prompts, interrupts, and approvals use
the separate resumed runtime ID. REST-returned compression descendant IDs and
profile identity are preserved.

Sidebar running indicators use the read-only `session.active_list` registry,
matching runtime `session_key` to the stored conversation ID in the requested
profile. `working` shows a spinner and `waiting` shows an input-needed dot;
`starting` alone is not proof that a turn is running. Resume and live events
update the selected conversation immediately. Background status refreshes every
five seconds while connected and on session-list refresh. The registry covers
the connected gateway process, not every agent on the installation. Older
gateways without this method still show the selected conversation's known state.

Recovery reads a bounded REST history page, then an omitted-history resume
snapshot. If a turn completes between those reads, the transcript is read again.
The snapshot restores running/inflight state and pending requests. Activity that
arrives after the snapshot is applied after recovery. Selection generations keep
late results from replacing a different conversation. Normal completion reloads
the authoritative history rather than appending another copy of the final reply.
An empty Hermes draft may have a stored key before its first persisted row.
A history 404 therefore attempts resume of that exact key; missing history is
accepted only when Hermes confirms a lazy, empty draft. A failed resume remains
a failure. Older history is fetched in pages of 50; sessions in pages of 20.

Sending is disabled during a known active turn. Hermes can still return queued,
steered, redirected, or busy behavior if another client changes the runtime
between checks; Agora displays the accepted status or error and does not retry.
No queue or steering controls are implemented. Uncertain send outcomes retain
an in-memory draft and block another send until the user acknowledges the warning.
A failed resume never creates a replacement conversation.

Approval responses use the server’s offered choices and original request IDs.
Clarification supports free text, single and multiple choices, locked answers,
and explicit skip. Unsupported requests remain visibly pending with a dashboard
link; the user can stop the turn. Request cancellations and expired/already
answered results are displayed. Agora never silently approves or answers a request.

In static browser-cookie mode, login is full browser navigation to `/login?next=<same-origin Agora path>`.
Hermes chooses the provider and owns callback, cookie refresh, and logout.
A 401 pauses the client for sign-in; a 403 or WebSocket policy rejection is shown
as a separate failure. There are no client OIDC tokens or automatic login redirects.
Logout submits Hermes’s `/auth/logout` form and closes the local gateway.

## Hosting at the domain root

Copy the production `dist/` contents to `/srv/www/agora/`. The UI, manifest,
icons, and assets are served at `/`, with conversation URLs such as
`https://agora.example.com/?session=…`. An example Nginx fragment inside that
domain's HTTPS server block:

```nginx
root /srv/www/agora;

location = /api/ws {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 90s;
}

location ~ ^/(api|auth)(/|$) {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location = /login {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location / {
    try_files $uri $uri/ /index.html;
}
```

The browser sees one origin: the Agora domain. Hermes may run on another machine;
replace the upstream address with its reachable dashboard URL. Keep API and auth
routes proxied rather than returning `index.html` for them. Static files alone do
not authenticate against an unrelated Hermes origin.

Keep Hermes’s backend port restricted. Configure its public URL as the HTTPS
origin, and the OIDC callback as `<origin>/auth/callback`, not the UI root.
Use the gated Hermes configuration and verify `/api/status` reports
`auth_required: true`: loopback mode alone can be ungated even behind a proxy.
Do not replace Host/Origin checks with an unconditional allow rule.

## Validation performed

Automated tests use synthetic data. They cover RPC readiness/correlation/framing,
ticket subprotocols, connection loss, heartbeat expiry, stale socket retirement,
RPC errors, 401 versus 403, stored/runtime IDs and profile propagation, delayed
selection results, reconnect ticket renewal without prompt resend, pending
approval/clarification recovery, live events after snapshots, sequence duplicates,
completion during recovery, exact unpersisted draft recovery, compression descendant URLs, draft retention,
upstream mutation failures, safe Markdown, and explicit interaction controls.
Local-service integration tests also cover PKCE verification, callback binding
and replay rejection, token privacy, concurrent refresh, expired grants, session
separation, mutation non-replay, Host/Origin rejection, gateway readiness, frame
forwarding, and logout socket closure. Type checking and production build are
part of `agora-check`.

Browser transport tests model the native `fetch` receiver check, which Node’s
fetch does not enforce. Component coverage exercises the real client startup
after login through identity, gateway initialization, and session loading.
Transient connection failures are shown while reconnecting rather than leaving
the interface without an error.

Firefox desktop and a 320 × 480 responsive viewport were inspected with the
backend unavailable. Empty/reconnecting state, composer sizing, and mobile
navigation were checked. This is layout validation, not a live Hermes chat test.

The built local server was started with the supplied endpoint: assets and local
connection metadata returned 200, remote status was reachable, unauthenticated
identity returned 401, and login redirected to Hermes with S256 PKCE and the
loopback callback. Hermes accepted that authorization request and redirected to
`https://auth.vjcbs.be/api/oidc/authorization`. Browser automation could not start,
so authenticated callback, live gateway, and chat acceptance remain unverified.

## Live acceptance checklist

With an OIDC-enabled installation on the source baseline:

- Confirm authenticated status, provider selection, callback, cookies, return to
  an Agora session URL, cookie refresh, expired login, and logout.
- Create/send/stream/stop; resume after reload; rename; confirm delete and verify
  upstream refusal during active writes. Check history and session pagination.
- Exercise approval and clarification, including multiple pending requests,
  cancellation, an expired request, and recovery of a question after reconnect.
- Disconnect during streaming and while a submit reply is outstanding; verify
  the run resumes and Agora never resends the prompt automatically.
- Switch sessions quickly; open a running session started elsewhere; follow a
  compression descendant; read older history without being scrolled to the end.
- Check keyboard controls, mobile viewport and on-screen keyboard, code blocks,
  and the static proxy’s deep-link and WebSocket behavior.

Record the actual Hermes revision, public origin, provider, profile, proxy, and
results before claiming a live-tested deployment.

### Background tasks

Agora displays delegated children from `subagent.*` events and the session-scoped
`subagent.list` RPC. It reads the roster after resume and every five seconds while
connected, including when the main turn is idle. Goals, status, model, tool counts,
last tool, and completion summaries are shown in the conversation. Recently failed
delegations returned by Hermes also appear. Reasoning chunks are not displayed.
Roster replies are guarded against session changes and newer live events.

Observed completions remain in memory when switching conversations; Hermes's
stored `async_delegation_complete` and `process_complete` rows appear as expandable
timeline notices after reload. A child disappearing from the live roster is marked
as no longer listed, not assumed successful. Its card is anchored during history
recovery even if the roster probe fails; matching stored delegation notices provide
its historical placement without inferring an individual child's outcome from
aggregate completion counts. Unanchored cards stay before the loaded transcript,
not after each new message. A live child recovered from an unknown state returns
to the pinned roster and clears its obsolete transcript anchor.
Older gateways without `subagent.list`
show a status-unavailable notice and can still display supported live events.
`background.complete` side-agent results are also displayed when received.
This is task visibility within chat, not a task-management interface or a global
installation roster. It does not enumerate unrelated background shell processes
or initiate `/background` side agents.

The sidebar marks completed replies and side-agent results received for known
conversations while another conversation is open. Opening and successfully
recovering a conversation clears its unread marker. Markers are scoped by stored
session ID and profile and kept only in memory; they do not represent a Hermes
account-level read receipt or survive reloading Agora. Interrupted or failed turns
do not create unread-response markers.

### Inline generated images

Assistant Markdown images and image `MEDIA:` markers render inline, including
whitespace or a line break between the marker and its path. Code examples stay
as text. Successful
`image_generate` tool results (`success` and `image`) also show previews outside
the collapsed tool details. History requests preserve structured `image_url`
content rather than replacing it with `[image]`.

Server-local paths are resolved by Hermes’s authenticated
`GET /api/fs/read-data-url?path=…&profile=…`, matching Conduit’s gateway file
resolver and supporting workspace images in the selected profile;
remote URLs use `GET /api/media/proxy?url=…`, subject to Hermes’s CDN allowlist.
The loopback bridge forwards these read-only routes with its server-held grants.
Images are rendered from validated image data URLs, kept only in component memory.
Raw HTML images and unsupported URL schemes remain blocked. Failed image requests
show an unavailable notice. Viewing a chat never reads Hermes files directly.

The sidebar requests sessions with `exclude_sources=cron`, so scheduled-job
conversations are excluded by Hermes before pagination and counting.

### Results workspace

The application rail order is Chats, Results, Memory, Cron. Results uses only the
existing read-only dashboard contracts: `GET /api/cron/jobs?profile=…`,
`GET /api/cron/jobs/<id>/runs?profile=…&limit=…`, and the existing profile-scoped
session-message history. No session is resumed, created, steered or mutated by
viewing Results. Manage job is navigation to Cron, not a job mutation.

The default sidebar selection is All results; selecting a job filters the feed.
Run metadata is sorted newest-first by `started_at`. The initial catalog requests
20 recent runs per job, with an explicit option to increase to the API maximum
100. The API has no run-list offsets, so this is not an unlimited archive.
The feed reveals ten cards at a time. Only displayed agent runs fetch the latest
50-message history page; older messages load explicitly inside the existing
read-only run dialog. A shared queue permits at most three reads at once, skips
obsolete queued work, and discards replies after profile/view/connection changes.
Available jobs remain visible when another job’s run listing fails; output errors
have a separate explicit retry.

The last nonempty ordinary assistant message in the latest turn supplies card
content through the shared history parser and safe Markdown renderer. Tool-call
preambles, reasoning-only content, hidden rows and delegated/background completion
artifacts do not become final answers. No output in the bounded latest page is
reported honestly, with the conversation available for further inspection.
Running and unknown outputs are not labeled final. Script-only `cron_output`
rows (including synthetic `cron_output:` IDs) are escaped output previews only;
Hermes collapses/truncates these to 180 characters. No verified full-output API
exists, and Agora never sends synthetic IDs to session history or reads internal
output files.

An explicit `ended_at` means Finished, not successful. Without an end timestamp,
`scheduler_owned` is authoritative when present: true means Running even when
`is_active` is false; false means Unknown rather than inferring an active owner.
Only when ownership is absent does `is_active` supply legacy Running evidence.
There is no Failed filter because the verified agent-run contract does not expose
reliable structured per-run failure status. Job `last_status`/`last_error` never
stamp arbitrary historical runs.

Polling runs every 15 seconds only while the workspace is active, connected and
`document.visibilityState` is visible. Unchanged finished output is retained in
component memory, keyed by job/run and completion/message/token metadata, so it
is not fetched on every tick. A profile change clears that cache. Details refresh
is explicit and independent of feed polling. No output or query is saved in
browser storage; Results does not implement full-archive output search.

Source behavior rechecked against installed Hermes revision
`d526f14714ce8a95cafd7f3a95d1eab5b6e0b910`, `hermes_cli/web_routers/cron.py`
and `sessions.py`. Unit tests exercise navigation order, chronological real
answers, filtering, lifecycle races, ownership evidence, partial failures,
concurrency/page limits, cache reuse, preview restrictions and older details.
`npm run screenshot` also checks Results navigation/filter/details/manage/mobile
behavior and writes light/dark desktop/mobile fixture screenshots. These are
mock-only checks, not authenticated live Hermes acceptance.

### Conversation search

Sidebar search combines title/ID matches from loaded chats with Hermes’s
`GET /api/sessions/search` results for stored message text and session IDs.
Queries are debounced, profile-scoped, and exclude cron sessions. Hermes returns
up to 100 matches; its endpoint does not support search pagination or title
search across unloaded conversations. Stale responses are discarded when the
query changes, clears, or the client disconnects. Queries and results remain
in memory. Clearing search restores the paginated conversation list.

### Composer model and reasoning choices

The composer reads `model.options` with `explicit_only=true` and session-aware
`config.get` for reasoning. Changes use `config.set` with the selected runtime ID
and profile. Model values include `--provider` and `--session`; reasoning uses
`scope=session`. Choosing a setting before a chat exists creates a session first
and preserves the unsent draft. Agora never writes profile-wide model defaults.

Hermes remains authoritative through resume/create info and `session.info` events,
including the effective `reasoning_effort_wire` when a route clamps the requested
effort. Inventory capabilities disable reasoning for models without support and
disable “None” where reasoning cannot be turned off. Switch confirmations and
warnings are shown to the user; deferred switches are labelled as queued rather
than reported as already active. Controls are disabled during a turn or setting
change. Ambiguous setting failures are not retried automatically. Inventory reads
do not delay normal chat recovery; unsupported methods show a refreshable error.

### Provider quota

The sidebar footer queries quota on demand through `cli.exec`, with the fixed
argument list `usage --provider <inventory slug> --json`, an explicit
`--profile=<selected profile>` when available,
and a 20-second server timeout. The CLI flag is required because this Hermes
revision does not apply the `cli.exec` RPC profile field to its subprocess. This invokes Hermes's existing read-only account
usage implementation rather than accessing credentials or vendor APIs in Agora.
The gateway combines stdout and stderr; the client extracts the quota JSON
document so startup warnings do not invalidate it. Request failures distinguish
unsupported methods, provider timeouts, and invalid responses.
The response schema is defined by
[`usage_snapshot_document`](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/subcommands/usage.py).
Quota windows report `used_percent` and `resets_at`; credit balances remain the
provider's plain-text `details`. Missing percentages are unavailable, not zero.

The provider picker uses the existing model inventory, independently of the
chat's selected model. Snapshots are cached in component memory for one minute,
scoped by profile and provider. Refresh forces a new request. Late replies are
discarded after switching providers, profiles, disconnecting, or unmounting.
Providers without supported account usage and old gateways fail visibly without
blocking chat. No agent session is created or modified to fetch quota.

### Memory review

The left icon rail switches the whole workspace between Chat and Memory without
unmounting the transcript or losing its draft. Chat shows conversation navigation;
Memory replaces it with navigation for pending updates, saved memory, user profile,
soul/instructions, and provider status. Memory approvals are identified by the upstream
`Save to memory:` description prefix or `tool_name: memory`. Both queued
`approval.pending` and server-to-client `approval` requests use the same readable
card. Saving sends only the offered `once` choice through the request's existing
response transport; rejection sends `deny`. No policy toggle or automatic
approval is exposed. All content remains safely rendered plain text in memory.

Opening Pending updates runs the existing `command.dispatch` RPC with `name: memory`,
`arg: pending`, and the current runtime session ID. This command binds the
session's profile; no new session or agent prompt is created. Unknown directives
or preview formats fail visibly. Hermes's shared
[write approval command handler](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/write_approval_commands.py)
returns truncated summaries, with pinned target entries when available. These are
labeled previews and have no approval controls. Full staged-write review remains unavailable through this command contract.
Saved-memory browsing uses the separate read-only learning API below; Agora does
not patch Hermes or read its private pending/memory files.

## Slash commands

The composer loads `commands.catalog` on demand when typing `/`, scoped to the
runtime session and profile. Suggestions include the server's built-ins, custom
commands, and skills. Enter or Tab selects a suggestion; the next Enter runs it.
Escape dismisses the picker. Commands can also be entered by name if discovery
is unavailable.

Execution uses `slash.exec` with the runtime ID, profile, and command without the
leading slash. Only an explicit 4018 refusal directing the client to
`command.dispatch` triggers that fallback. Worker failures, timeouts, and lost
connections are never retried through a different method or sent as ordinary
prompts. Ambiguous outcomes require user review before another send.

Plain output and plugin output render as escaped text in compact transcript
cards. Send/skill directives submit their resolved prompt once, displaying the
invocation instead of expanded skill instructions. Prefill directives such as
`/undo` refill the composer without sending. Alias chains are bounded. Session
switches invalidate delayed results and prevent follow-up execution in another
conversation. Successful output/prefill commands reconcile history and settings.
Command output stays in memory for this browser tab; Hermes does not persist it
as chat history, and refreshing the page clears it. Commands are disabled while
the current agent turn runs, consistent with ordinary chat sends.

Contracts checked against `tui_gateway/methods_tools.py`,
`apps/shared/src/slash.ts`, and the desktop slash handler in the researched Hermes
revision. Available commands and their effects remain Hermes's responsibility;
Agora does not patch or emulate unsupported backend commands.

## Command approvals

Command approval cards show Hermes's redacted command text and reason. **Allow
once** and **Reject** are the primary actions; conversation/permanent approvals
appear under **More options** only when offered by Hermes. Missing command text
cannot be approved. Content renders as text, never executable HTML.

Current `approval` server requests answer through `request.answer` with the
original server request ID and `{ choice }`. Legacy `approval.request` events
and replayed `approval.pending` queue entries answer through `approval.respond`
with the queue's `request_id`. Duplicate event/request cards are suppressed by
that queue ID. Older entries without an ID can only answer the currently displayed
oldest queue entry. Decisions are never inferred or sent on receipt.

Cards disappear on successful decisions or authoritative withdrawal.
`request.cancel` also removes the corresponding replayed queue entry;
`approval.cancelled.request_ids` removes only affected entries. Failed decisions
keep the card and show the error. Stale requests and choices not offered by Hermes
cannot send decisions. Pending requests show a waiting-for-input status and follow
the transcript when the user is already at its bottom.

### Memory inspection

Inspection is scoped to the selected profile. When no profile
is named, `GET /api/profiles/active` supplies `current` (the running dashboard's
profile), not the sticky CLI `active` setting. An unknown custom profile fails
visibly rather than guessing `default`. No new session or agent turn is created.

- **Saved memory / User profile:** `GET /api/learning/graph?profile=…` returns
  memory nodes for `MEMORY.md` (`memorySource: memory`) and `USER.md`
  (`memorySource: profile`). Graph bodies are previews capped at 1,200 characters.
  Opening an entry fetches `GET /api/learning/node?id=…&profile=…`, which returns
  the full memory chunk. IDs come from Hermes; stale entries show an error and
  can be refreshed. Skill nodes are excluded.
- **Soul & instructions:** `profiles.describe { name }` returns the stored
  profile soul and description. `config.get` for `personality` and `prompt`
  supplies the selected personality and custom instructions. These independent
  reads preserve available sections when another is unsupported. This is stored
  profile configuration, not a dump of a running agent's assembled system prompt.
- **Memory providers:** `GET /api/memory?profile=…` returns the active external
  provider (empty means built-in), discovered provider readiness, and built-in
  memory/user file sizes. No provider configuration or credentials are queried.
  External providers' own memory contents are not exposed by these endpoints.

The local bridge permits GET for these four HTTP paths, plus PUT and DELETE
for `/api/learning/node`. Edit sends `{id, profile, content}`; delete sends
`{id, profile}`. Only fingerprinted built-in memory/profile IDs are accepted
for writes, avoiding legacy positional targets. The editor reloads full text
before editing or deletion confirmation. Save/delete never retry automatically;
failures retain the draft and successful writes refresh the list. Profile/view
changes discard delayed UI results, but do not cancel a submitted write.
Soul edits, provider switching, and memory reset are not exposed. Loads occur when a
section opens, its profile changes, or Refresh is clicked; full entries load on
request. Closing/switching a view discards delayed results. Content is escaped
text, kept only in component memory.

Sources: [learning graph](https://github.com/NousResearch/hermes-agent/blob/main/agent/learning_graph.py),
[node inspection](https://github.com/NousResearch/hermes-agent/blob/main/agent/learning_mutations.py),
[dashboard learning API](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/web_routers/status.py),
[profile snapshot](https://github.com/NousResearch/hermes-agent/blob/main/tui_gateway/methods_profiles.py),
and [provider status](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/web_routers/ops.py).

### Context compression status

The pinned composer status uses session-scoped `status.update` events:
`compacting` / `compressing` start it; `compacted` / `ready` clear it.
Verified legacy `lifecycle` compression progress notices are also recognized.
Normal message deltas, tool starts, errors, disconnection, and conversation
switching clear stale progress. Manual `/compress` and `/compact` show progress
while awaiting their result; a compute-host `status: pending` result keeps the
indicator until a terminal event, without re-running the command.

Snapshots do not expose a verified compression phase, so reconnecting waits for
fresh status events rather than inferring compression from `running`.
Contracts: [gateway status](https://github.com/NousResearch/hermes-agent/blob/main/tui_gateway/server.py),
[manual compression](https://github.com/NousResearch/hermes-agent/blob/main/tui_gateway/methods_session.py),
[automatic compression](https://github.com/NousResearch/hermes-agent/blob/main/agent/conversation_compression.py).

### Thinking traces

Agora appends session-scoped `reasoning.delta` text to an assistant's separate
reasoning block. `reasoning.available` provides a completed block and does not
duplicate a matching streamed prefix. Completed reasoning notices attach to the
existing reply row; a complete final answer repeated at the end of a trace is
removed during completion/history recovery, while the normal reply stays visible. The collapsed Thinking item shows a spinner
while receiving reasoning and opens to sanitized Markdown using the same renderer
as chat replies. Raw HTML and unsafe links are disabled. Reply text, tool starts,
compression, completion, errors, and disconnects stop its spinner. A waiting
assistant with no supplied trace shows that limitation when expanded.

History reads readable `reasoning_content` / `reasoning` strings,
`reasoning_details` entries of type `reasoning.text` / `reasoning.summary`,
and Codex `reasoning` items' `summary_text` summaries. Encrypted content,
signatures, and opaque replay items are never rendered. These may be summaries
or previews rather than a full internal reasoning trace.

Captured live traces stay in tab memory per stored session and profile across
completion recovery and conversation switches. History data takes precedence;
ambiguous prompt matches are discarded. Refresh relies on what Hermes persisted.
No traces are logged or stored in browser storage, and Agora does not enable
reasoning disclosure when Hermes has it disabled. `thinking.delta` is treated as
activity text because current upstream uses it for waits and diagnostics too.

Sources: [reasoning callbacks](https://github.com/NousResearch/hermes-agent/blob/main/tui_gateway/agent_callbacks.py),
[reasoning events](https://github.com/NousResearch/hermes-agent/blob/main/tui_gateway/contracts/events.py),
[readable reasoning details](https://github.com/NousResearch/hermes-agent/blob/main/agent/reasoning_summaries.py),
and [history fields](https://github.com/NousResearch/hermes-agent/blob/main/hermes_state_messages.py).

### Images attached to prompts

The composer accepts PNG, JPEG, WebP, and GIF files through a picker, clipboard
paste, or drop. Limits are 8 images and 10 MB each. Local data-URL previews and
image drafts stay in tab memory, scoped by stored session and profile.

Send uploads each image with `image.attach_bytes`, using
`{session_id, profile, filename, content_base64}`, checks `attached: true` and
the returned `path`, then calls the existing `prompt.submit` with text. Hermes
owns its attachment queue and image routing; image-only prompts send empty text.
Known upload failures detach confirmed queued paths through
`image.detach {session_id, profile, path}`. Conversation switches stop before
submitting a prompt and clean up confirmed uploads in the original runtime.
Ambiguous connection failures block resend rather than retrying uploads or prompts.
Slash commands with images are rejected explicitly.

Sent images appear in user messages. History's `image_url` content parts and trailing `@image:` references render
as images separately from the user caption. References support quoted paths, and
trailing `[screenshot]` placeholders are removed when references identify the
attachments. Images are fetched through the existing profile-scoped media API.
When both forms are present, references take precedence to avoid duplicate images. Restoring older sessions relies on
the image references Hermes actually returns; the client does not read its
private session/image storage. No Hermes API changes are required.

Sources: [attachment handlers](https://github.com/NousResearch/hermes-agent/blob/main/tui_gateway/methods_prompt.py),
[attachment contracts](https://github.com/NousResearch/hermes-agent/blob/main/tui_gateway/contracts/prompt_voice.py),
and [image routing](https://github.com/NousResearch/hermes-agent/blob/main/tui_gateway/prompt_turn.py).

### Image viewer

Loaded images in chat messages (attachments, Markdown, and generated tool images)
open an enlarged modal viewer on click or keyboard Enter/Space. The viewer reuses
the loaded image data URL without another media request. Native dialog focus
trapping keeps keyboard navigation inside the viewer; Escape, the close button,
or a backdrop click dismisses it and restores focus to the thumbnail. Images
fit the viewport on desktop/mobile and the viewer follows system appearance.
