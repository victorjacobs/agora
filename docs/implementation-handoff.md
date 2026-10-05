# Implementation handoff

The initial client is now implemented. See [integration.md](integration.md) for
implementation behavior and validation limits. This document retains the original
research baseline and planning observations. The original same-origin suggestion
is now optional: the owner requested standalone laptop use with a configurable
endpoint. See [integration.md](integration.md#laptop-connection) for the implemented
loopback PKCE service; native desktop packaging remains deferred.

## Objective and fixed decisions

**Required:** implement the small chat client described in [product.md](product.md).
Vue, Nix/direnv, direct Hermes manage/dashboard integration, and login through
Hermes OIDC are fixed. Hermes owns persistence and execution; no Agora database,
agent runner, or independent authentication backend.

**Suggested:** Vue 3 + TypeScript + Vite, npm with a lockfile, static production
assets, and a single server/profile. Choose remaining libraries during
implementation. Keep API and WebSocket state testable outside components.

## Current system and references

**Observed, 2026-10-05:** Agora was empty apart from `.git`. This handoff adds
documentation and a minimal Nix shell; there is no app, test suite, or deployment.
`~/dev/tob` uses Vue/TypeScript/Vite, npm, a Nix flake with direnv/devenv, and
same-origin routing. Relevant local files: `flake.nix`, `devenv.nix`, `.envrc`,
`frontend/package.json`, and `frontend/vite.config.ts`. Borrow conventions, not
its Go backend, PostgreSQL service, or password authentication.

Source snapshots inspected (not a tested compatibility matrix):

| Repository | Revision | Use |
| --- | --- | --- |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/e1fdf003a668f97bf5a53d7675c1e70b1dcfec34) | `e1fdf003a668f97bf5a53d7675c1e70b1dcfec34` | Authoritative dashboard and gateway contracts |
| [Hermes Conduit](https://github.com/kaishi00/hermes-conduit/tree/7ff9d85377f02a63b5fbd3a13866d4de538efa0b) | `7ff9d85377f02a63b5fbd3a13866d4de538efa0b` | Direct-client behavior and recovery reference |
| [hermes-webui](https://github.com/nesquena/hermes-webui/tree/8368f5522d086b604c6f23a6b22ea52c5cf40ebe) | `8368f5522d086b604c6f23a6b22ea52c5cf40ebe` | UI reference only; contains direct SQLite access |

The verified upstream command is `hermes dashboard`. “Manage/dashboard” in this
project means that built-in server, not a guessed `/manage` API or the separate
`gateway/platforms/api_server.py` API. Do not mix those protocols.

## Relevant upstream code

Paths below are relative to the pinned Hermes Agent tree above:

- `hermes_cli/web_routers/sessions.py`: HTTP session list/history/rename/delete.
- `hermes_cli/web_routers/chat_ws.py` and `hermes_cli/web_server_chat.py`:
  WebSocket mount, ticket authentication, and Host/Origin checks.
- `hermes_cli/dashboard_auth/routes.py`, `middleware.py`, `cookies.py`:
  browser login, callback, identity probe, refresh, logout, and ticket minting.
- `plugins/dashboard_auth/self_hosted/__init__.py`: generic OIDC provider.
- `tui_gateway/ws.py`, `tui_gateway/contracts/sessions.py`,
  `prompt_voice.py`, and `events.py`: wire behavior and typed contracts.
- `apps/shared/src/gateway-contract.generated.ts`, `gateway-events.ts`, and
  `json-rpc-gateway.ts`: existing TypeScript definitions/client machinery.
  Assess reuse and license obligations before copying or adding dependencies;
  do not import the entire upstream desktop application.
- `website/docs/user-guide/features/web-dashboard.md`: operator configuration.

In Conduit, inspect `Conduit/Services/HermesClient.swift`,
`PersistedTranscriptWindow.swift`, and `ChatResumePolicy.swift` for recovery
behavior. `NativeAuthClient.swift` documents the native PKCE protocol now used
by Agora’s local Node service. The callback terminates in that service, not in
the SPA; hosted static mode continues to use browser cookie login.

## Observed HTTP and WebSocket surface

This is an orientation map, not a complete schema. Inspect request/result types
against the actual server before implementation.

| Operation | Verified surface | Notes |
| --- | --- | --- |
| Server/auth status | `GET /api/status` | Inspect `auth_required`; ungated mode is not an OIDC test |
| Providers / identity | `GET /api/auth/providers`, `GET /api/auth/me` | Provider names come from Hermes; identity response omits tokens |
| Browser login | `GET /login?next=…` or `/auth/login?provider=…&next=…` | Full browser navigation; `next` must be a safe same-origin path |
| Callback / logout | `GET /auth/callback`, `POST /auth/logout` | Hermes sets/clears cookies; logout redirects to its login page |
| Live-chat credential | `POST /api/auth/ws-ticket` | Returns `ticket`, `ttl_seconds`; single-use, currently 30 seconds |
| Sessions | `GET /api/sessions?order=recent&limit=20&offset=0` | Profile-aware; server has pagination/filter defaults |
| History | `GET /api/sessions/{id}/messages` | Explicit `limit`, `offset`, `order=latest`; returns resolved ID and pagination |
| Rename / delete | `PATCH /api/sessions/{id}`, `DELETE /api/sessions/{id}` | Rename body includes `title` and optional `profile`; check deletion parameters |
| Live transport | `/api/ws` | JSON-RPC 2.0, not REST chat or SSE |

In gated mode, obtain a fresh ticket per socket attempt. The inspected server
accepts protocols `hermes-gateway-v1` and `hermes-gateway-ticket.<ticket>` together,
or `?ticket=…`. Prefer the supported subprotocol mechanism to keep tickets out of
URLs; verify it against the deployed version and proxy. Ordinary cookies alone
are not the documented ticket exchange. Never expose a static backend token.

The initial notification has `method: "event"` and
`params: {type: "gateway.ready", payload: …}`. Other events use that envelope,
with session identity and optional sequence information. Wait for readiness,
correlate RPC replies by ID, and support the upstream newline-delimited framing
(including coalesced events). Do not assume each message is one text delta.

Relevant RPCs are `session.create`, `session.resume`, `prompt.submit` (text and
session ID), and `session.interrupt`. Create returns both `session_id` and
`stored_session_id`. Incoming activity includes `message.start`, `message.delta`,
`message.complete`, tool/status events, and requests needing user input. Inspect
`approval.pending`, `approval.respond`, `request.answer`, and server-to-client
request contracts rather than inventing a generic approval payload.

## Original suggested browser/deployment arrangement (hosted mode)

Use one public origin, for example `https://hermes.example.com`:

| Public path | Owner |
| --- | --- |
| `/agora/` and its assets/client routes | Agora static files, with SPA fallback only here |
| `/api/*`, including `/api/ws` | Hermes, preserving HTTP errors and WebSocket upgrades |
| `/login`, `/auth/*`, and remaining dashboard routes | Hermes |

This preserves the existing dashboard and avoids cross-origin cookies/CORS as a
v1 requirement. A reverse proxy is routing infrastructure, not a second agent
backend. Do not put an SPA fallback in front of auth/API routes. Mirror this
layout in the Vite development proxy; confirm Host/Origin handling rather than
disabling Hermes's checks.

Login navigates to `/login?next=%2Fagora%2F` (or a validated conversation route).
Hermes performs the provider exchange at `/auth/callback`, sets HttpOnly cookies,
and returns to Agora. Probe `/api/auth/me`, then mint the socket ticket. On auth
expiry, pause actions and offer sign-in again; distinguish 401 from network/403
errors and avoid redirect loops. Logout must reach Hermes and clear local chat
state/close sockets. Hosted browser mode leaves refresh to Hermes. Laptop mode
instead performs native-token refresh in the local service, outside the browser.

Configure OIDC on Hermes, not in Vite environment variables. Relevant operator
settings are `HERMES_DASHBOARD_OIDC_ISSUER`, `HERMES_DASHBOARD_OIDC_CLIENT_ID`, and
`HERMES_DASHBOARD_PUBLIC_URL`. For the example above, public URL is
`https://hermes.example.com` and the registered callback is
`https://hermes.example.com/auth/callback`, not `/agora/`. The configured provider
can be `self-hosted`; discover available providers instead of hardcoding Nous.

**Observed trap:** this revision activates the auth gate on non-loopback binds;
the ordinary loopback dashboard is ungated. Putting a proxy in front does not
automatically turn authentication on. Verify `/api/status` reports auth required,
use a gated backend configuration, and keep its listening port restricted by the
deployment. A real login/callback test must exercise that configuration.

## Findings and constraints

- The dashboard is a machine-management surface. OIDC authenticates access;
  do not promise independent private chat accounts or invent client-side tenancy.
- REST history can resolve an ID to a compression descendant and include ancestor
  messages. Runtime IDs and durable IDs are distinct. Carry profile context
  consistently through REST and RPC, even without a profile picker.
- Resume snapshots contain running/pending state and can be partial. Paginate
  history explicitly, reconcile it with live activity, and prevent stale fetches
  from replacing the newly selected session. Do not concatenate snapshots blindly.
- A disconnect does not cancel a run. Reconnect with backoff and a new ticket,
  then resume/reconcile. Do not create a replacement chat when resume fails.
- A lost submit reply has an ambiguous outcome. Do not automatically resend;
  reconcile with Hermes and let the user decide if necessary. Create has an
  optional idempotency key in this revision; verify support before relying on it.
- Approval/input prompts can survive reconnects. Restore authoritative pending
  state, keep request IDs, and handle expired/already-answered requests visibly.
- Browser storage should not become a second transcript database. Use server
  history and transient UI state; avoid raw HTML and credential/content logging.

## Open questions for implementation

**Original unknowns:** the deployed Hermes revision, public URL, OIDC provider,
profile, and reverse-proxy setup. The owner subsequently supplied
`https://hermes-manage.vjcbs.be`; its public status advertises cookie and native
PKCE authentication through a self-hosted provider. Its exact revision remains
unverified. Confirm live authenticated behavior before claiming compatibility. The inspected HEAD is a research
baseline, not a minimum supported release or proof of successful integration.

**Unknown:** which upstream client/types can be consumed cleanly as a dependency
versus a small attributed subset. Check packaging, licensing, framing, heartbeat,
and replay behavior before writing new transport code.

**Suggested defaults, not additional features:** use `/agora/`, one server/profile,
and static assets. Resolve exact history reconciliation, deletion during a live
turn, and the supported approval/input shapes from the target server's contracts
and tests. Surface incompatibilities instead of silently dropping interactions.

## Validation

The shell can be checked with `nix flake check path:. --no-build`; use
`nix develop path:.` or direnv for application checks once implemented. Add and
document actual typecheck, test, and build commands with the application.

Meaningful automated coverage: RPC correlation/framing, auth expiry, ticket renewal,
session switching with delayed results, reconnect/history reconciliation without
duplicate prompts, ID changes, and pending approval recovery. Use synthetic data.

With a real gated Hermes + OIDC deployment, verify login/callback/return, refresh,
logout, new/resumed chat, streaming, stop, rename/delete, history pagination,
and an approval/clarification round trip. Reload during a run and disconnect
mid-stream; confirm resumption without restarting the prompt. Check desktop/mobile
layout, keyboard use, Markdown safety, and deep-link reloads. Record the tested
Hermes revision and deployment arrangement. Mock-only tests do not establish
OIDC, cookie, Origin, or proxy compatibility.
