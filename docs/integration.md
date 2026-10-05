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
`agora-start`. The local URL is `http://127.0.0.1:5173/agora/`. The endpoint is a
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
with tool names and safely rendered plain-text output. Grouping preserves order
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

In hosted mode, login is full browser navigation to `/login?next=<same-origin Agora path>`.
Hermes chooses the provider and owns callback, cookie refresh, and logout.
A 401 pauses the client for sign-in; a 403 or WebSocket policy rejection is shown
as a separate failure. There are no client OIDC tokens or automatic login redirects.
Logout submits Hermes’s `/auth/logout` form and closes the local gateway.

## Same-origin routing example

Copy the production `dist/` contents to `/srv/www/agora/`. An example Nginx
routing fragment, inside an existing HTTPS server block:

```nginx
root /srv/www;

location = /agora { return 308 /agora/; }
location /agora/ {
    try_files $uri $uri/ /agora/index.html;
}

location = /api/ws {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 90s;
}

location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Keep Hermes’s backend port restricted. Configure its public URL as the HTTPS
origin, and the OIDC callback as `<origin>/auth/callback`, not `/agora/`.
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
as no longer listed, not assumed successful. Older gateways without `subagent.list`
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
