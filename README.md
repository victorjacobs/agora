# Agora

A small Vue chat client for the built-in Hermes dashboard. Hermes runs the agent,
keeps conversations, and authenticates users through OIDC. Run Agora on your
laptop with a configured remote Hermes endpoint, or serve its static files beside
Hermes. Agora has no agent runner, database, or Hermes home mount.

The initial implementation includes paginated sessions and history, new/resumed
chats, rename and confirmed delete, streamed replies, stop, tool activity,
approvals, clarification questions, login/logout, and connection recovery.
The layout works on desktop and mobile. Markdown is rendered with raw HTML
disabled and sanitized; embedded images are not loaded.

**Compatibility target:** Hermes revision
[`e1fdf003a668f97bf5a53d7675c1e70b1dcfec34`](https://github.com/NousResearch/hermes-agent/tree/e1fdf003a668f97bf5a53d7675c1e70b1dcfec34).
This is a source-verified integration target, not a live-tested compatibility claim.
Authenticated acceptance testing against the supplied Hermes deployment is still pending.

## Run on your laptop

With Nix flakes and direnv’s Nix integration installed:

```sh
direnv allow
npm ci
cp .env.example .env.local
```

Set the remote server in `.env.local`:

```dotenv
HERMES_ENDPOINT=https://hermes-manage.vjcbs.be
```

Run `agora-dev` and open **http://127.0.0.1:5173/agora/**. Click **Sign in with
Hermes** and complete the server’s login in your browser. Restart Agora after
changing the endpoint. Optionally set `VITE_HERMES_PROFILE`; omitting it uses
Hermes’s launch profile. OIDC provider credentials belong on Hermes.

The local service listens only on loopback. It uses Hermes’s native PKCE login,
keeps access/refresh tokens in memory, and forwards HTTP and WebSocket requests.
The browser receives an opaque HttpOnly local session cookie. No CORS or remote
proxy changes are needed. The server must advertise `native_pkce` in
`/api/status`; the supplied endpoint does. A static browser app alone cannot
use this mode: keep the local process running.

Login survives page reloads, but restarting the local process requires signing
in again. Local logout discards its tokens and closes its sockets; it does not
end the identity provider’s browser SSO session. Credentials are never persisted
by Agora. Desktop packaging and OS credential storage are deferred.

To run a production build locally:

```sh
npm run build
agora-start
```

`agora-start` uses the same `.env.local` and local URL. Set `AGORA_PORT` to change
its port. `npm run preview` also supports the configured endpoint.

## Development

The shell provides Node.js 24/npm, Git, ripgrep, `agora-dev`, `agora-start`, and
`agora-check`. Without direnv:

```sh
nix develop path:. --command npm ci
nix develop path:. --command agora-dev
nix develop path:. --command agora-check
nix flake check path:. --no-build
```

Individual checks are `npm run typecheck`, `npm test`, and `npm run build`.
Build output (`dist/`), dependencies, and `.env.local` are gitignored.

Without `HERMES_ENDPOINT`, development retains the same-origin proxy mode using
`HERMES_TARGET` (default `http://127.0.0.1:8080`). That mode requires Hermes to
accept the browser Host/Origin and cookie login callbacks.

## Deployment

For static hosted deployment, omit `HERMES_ENDPOINT` and serve `dist/` at
`/agora/` on the same HTTPS origin as Hermes. Preserve `/api/*`,
`/login`, `/auth/*`, and the existing dashboard, including WebSocket upgrades.
SPA fallback belongs only under `/agora/`. Selected conversations use
`/agora/?session=<stored-id>`, so reload and login return preserve the selection.

See [integration and deployment](docs/integration.md) for routing, protocol
behavior, and the live acceptance checklist. Dashboard access is access to the
operator’s Hermes installation; Agora does not promise per-user session isolation.

Drafts, tickets, and transcripts stay in memory and are not written to browser
storage. A disconnected socket does not imply the agent stopped. Recovery reads
server history and resumes the runtime before enabling actions. An ambiguous
send is never retried automatically; its draft is retained until the user checks
the recovered conversation and explicitly chooses to keep editing.

## Project documentation

- [Product scope](docs/product.md)
- [Implementation handoff and upstream research](docs/implementation-handoff.md)
- [Integration, architecture, and validation](docs/integration.md)
- [Agent instructions](AGENTS.md)
- [Upstream attribution](THIRD_PARTY_NOTICES.md)
