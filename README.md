# Agora

A minimal Vue chat interface for Hermes Agent, using the built-in Hermes
manage/dashboard APIs. Hermes remains responsible for running the agent,
persisting conversations, and authenticating users through OIDC.

**Status:** planning and development-shell scaffold only. The UI is not implemented.

The first version covers new chats, session history, resuming conversations,
renaming/deleting sessions, streaming replies, stopping a turn, and responding to
agent requests for approval or clarification. It should work on desktop and mobile.

[hermes-webui](https://github.com/nesquena/hermes-webui) is a product reference;
[Hermes Conduit](https://github.com/kaishi00/hermes-conduit) is a reference for
connecting directly to Hermes. Agora will not require either application or access
Hermes's SQLite store. No separate Agora backend or database is planned.

## Development environment

With Nix flakes and direnv's Nix integration installed:

```sh
direnv allow
```

The shell provides Node.js 24 (including npm), Git, and ripgrep. Alternatively:

```sh
nix develop path:.
nix flake check path:. --no-build
```

The explicit `path:.` reference includes this initial scaffold before its files
are tracked by Git. Dependencies, app commands, and a production package will be
added during implementation. There is no application to start yet.

## Intended integration

Suggested deployment: static Agora assets at `/agora/` and the existing Hermes
dashboard on the same public HTTPS origin. A reverse proxy serves Agora assets
and forwards Hermes routes, including authentication and WebSocket upgrades.
Hermes handles the OIDC callback; the browser returns to Agora after login.

An existing Hermes installation with a working dashboard and OIDC provider is
required for end-to-end testing. The exact supported Hermes revision is still to
be established; the handoff records the upstream revision inspected.

- [Product scope](docs/product.md)
- [Implementation handoff and API research](docs/implementation-handoff.md)
- [Agent instructions](AGENTS.md)

Development conventions take inspiration from `~/dev/tob`: Vue/TypeScript/Vite,
locked dependencies, Nix/direnv, and a shared browser origin. Its Go/PostgreSQL
backend and application-owned authentication are not needed here.
