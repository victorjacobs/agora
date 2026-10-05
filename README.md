# Agora

A small Vue chat client for the built-in Hermes dashboard. Hermes runs the agent,
keeps conversations, and authenticates users through its browser OIDC flow.
Agora is a static application; it needs no backend, database, or Hermes home mount.

The initial implementation includes paginated sessions and history, new/resumed
chats, rename and confirmed delete, streamed replies, stop, tool activity,
approvals, clarification questions, login/logout, and connection recovery.
The layout works on desktop and mobile. Markdown is rendered with raw HTML
disabled and sanitized; embedded images are not loaded.

**Compatibility target:** Hermes revision
[`e1fdf003a668f97bf5a53d7675c1e70b1dcfec34`](https://github.com/NousResearch/hermes-agent/tree/e1fdf003a668f97bf5a53d7675c1e70b1dcfec34).
This is a source-verified integration target, not a live-tested compatibility claim.
A real gated Hermes/OIDC deployment is still needed for acceptance testing.

## Development

With Nix flakes and direnv’s Nix integration installed:

```sh
direnv allow
npm ci
agora-dev
```

Open `http://localhost:5173/agora/`. The development proxy defaults to
`http://127.0.0.1:8080`. Copy `.env.example` to `.env.local` to change
`HERMES_TARGET` or set `VITE_HERMES_PROFILE`. Omit the profile to use the server’s
launch profile. OIDC credentials belong in Hermes configuration, never in Vite.

The proxy preserves browser Host and Origin. Hermes must accept the development
origin; Agora does not disable its checks. Production uses a shared public origin.
A development proxy does not establish production OIDC compatibility.

The shell provides Node.js 24/npm, Git, ripgrep, `agora-dev`, and `agora-check`.
Without direnv:

```sh
nix develop path:. --command npm ci
nix develop path:. --command agora-dev
nix develop path:. --command agora-check
nix flake check path:. --no-build
```

Individual checks are `npm run typecheck`, `npm test`, and `npm run build`.
The build produces `dist/`. `npm run preview` previews those static assets;
it does not proxy Hermes APIs.

## Deployment

Serve `dist/` at `/agora/` on the same HTTPS origin as Hermes. Preserve `/api/*`,
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
