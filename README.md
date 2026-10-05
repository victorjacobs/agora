# Agora

A focused chat client for [Hermes Agent](https://github.com/NousResearch/hermes-agent).
Run it on your laptop and connect to your own Hermes server, or host it alongside
the Hermes dashboard. Hermes runs the agent, stores conversations, and handles
sign-in. Agora provides the chat interface.

- Streamed replies, Markdown, code, and inline generated images.
- A compact chat list grouped by date, with running and unread-reply indicators.
  Search loaded titles and stored message text; cron-job conversations are excluded.
- Expandable tool activity and background-task progress, results, and errors.
  Running tasks stay above the composer; finished tasks remain in the transcript.
- Model and reasoning-effort choices scoped to each conversation.
- Tool approvals and clarification questions.
- New chats, history, rename, delete, and stop controls.
- Automatic light/dark appearance and a layout that works on desktop and mobile.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/chat-dark.png">
  <img src="docs/screenshots/chat-light.png" alt="Agora showing a conversation, chat search, tool activity, and a background task" width="1280">
</picture>

*The application with sample conversation data. The screenshot follows your light or dark appearance.*

## Run on your laptop

You need:

- Nix with flakes enabled, plus direnv configured with Nix support.
- A running Hermes **built-in dashboard** reachable from your laptop.
- For authenticated remote use, Hermes must advertise `native_pkce` in
  `GET /api/status` and have its sign-in provider configured.

Agora connects to Hermes's dashboard HTTP APIs and chat WebSocket. It does not
connect to `hermes-webui` or the separate Hermes API-server interface.

Clone this repository, then run these commands from its root:

```sh
direnv allow
npm ci
cp .env.example .env.local
```

Edit `.env.local` and set your server address:

```dotenv
HERMES_ENDPOINT=https://hermes.example.com
```

Start Agora:

```sh
agora-dev
```

Open **http://127.0.0.1:5173/agora/** and click **Sign in with Hermes** if prompted.
Complete the sign-in in your browser. Keep the local process running while using
Agora. Restart it after changing the endpoint.

The local service connects to remote Hermes on your behalf, so Hermes does not
need to host Agora or enable browser CORS. Login survives page refreshes;
restarting the local process requires signing in again. Desktop packaging is not
implemented yet.

### Configuration

| Setting | Purpose |
| --- | --- |
| `HERMES_ENDPOINT` | Remote dashboard URL for laptop mode. HTTPS is required except for loopback test servers. URL path prefixes are supported. |
| `VITE_HERMES_PROFILE` | Optional Hermes profile. Omit it to use the server's launch profile. Vite reads this when starting development or building the UI. |
| `AGORA_PORT` | Port for `agora-start`; defaults to `5173`. |
| `HERMES_TARGET` | Development proxy target when `HERMES_ENDPOINT` is omitted; defaults to `http://127.0.0.1:8080`. |

Keep provider credentials on Hermes. `.env.local` is ignored by Git.

### Run the built application

From the development shell:

```sh
npm run build
agora-start
```

Open the same local URL. This serves `dist/` without development hot reload.
`HERMES_ENDPOINT` is read at startup, so changing the server does not require a
new build. Changing `VITE_HERMES_PROFILE` does.

## Development

The app uses Vue, TypeScript, and Vite. The Nix shell provides Node.js 24, npm,
Git, ripgrep, and the project commands. The flake supports Apple Silicon macOS
and x86_64/aarch64 Linux.

After `direnv allow` and `npm ci`:

| Command | Purpose |
| --- | --- |
| `agora-dev` | Start the development server with hot reload. |
| `agora-check` | Run type checking, tests, and the production build. |
| `npm run typecheck` | Check TypeScript and Vue components. |
| `npm test` | Run the Vitest suite. |
| `npm run build` | Build the UI into `dist/`. |
| `agora-start` | Serve a built UI with the local Hermes connection service. |
| `agora-screenshot` | Regenerate the README screenshots using sample data. |
| `agora-icons` | Regenerate raster favicons from the original [icon](docs/branding/icon.png). |

Without direnv, use the same Nix environment explicitly:

```sh
nix develop path:. --command npm ci
nix develop path:. --command agora-dev
```

Before submitting changes:

```sh
nix develop path:. --command agora-check
nix flake check path:. --no-build
```

Commit changes to `package-lock.json` or `flake.lock` when changing dependencies
or Nix inputs. Dependencies (`node_modules/`), build output (`dist/`), and local
configuration are ignored by Git.

To regenerate the screenshots, run `agora-screenshot`. It uses Playwright with
an installed Chrome/Chromium browser, automatically finding Chrome on macOS.
Set `AGORA_BROWSER_PATH` if your browser executable is elsewhere. The command
starts its own temporary server and mocks Hermes responses; it does not access
your server or include your conversation history.

### Code layout

| Path | Responsibility |
| --- | --- |
| `src/App.vue` and Vue components | Chat interface, sidebar, tool/task views, and sign-in. |
| `src/hermes/chat.ts` | Conversation state, streaming, recovery, approvals, and session switching. |
| `src/hermes/api.ts`, `gateway.ts`, `types.ts` | Hermes HTTP and WebSocket contracts. |
| `src/hermes/transcript.ts`, `media.ts` | History normalization and image loading. |
| `src/theme.css`, `src/style.css` | System appearance and shared layout. |
| `server/` | Loopback login, authenticated API/WebSocket forwarding, and local serving. |
| `tests/` | Interface, transport, protocol, authentication, and recovery tests. |

Keep Hermes protocol and authentication logic outside Vue components. Verify
upstream contracts before changing request parameters or event handling.

## Host alongside Hermes

Standalone Nix expressions are available in [nix/package.nix](nix/package.nix)
and [nix/module.nix](nix/module.nix); they are not exposed through the flake.
See [Nix packaging and NixOS](docs/nix.md) for package builds, service configuration,
and using the packaged static files alongside Hermes.

For a static deployment, omit `HERMES_ENDPOINT` when building:

```sh
npm run build
```

Serve `dist/` at `/agora/` on the **same HTTPS origin** as Hermes. Keep the existing
dashboard and `/api/*`, `/login`, and `/auth/*` routes, including WebSocket upgrades.
Apply SPA fallback only under `/agora/`. The static UI uses Hermes's browser login
and session cookies directly; it does not need the local service.

For development in this mode, omit `HERMES_ENDPOINT` and set `HERMES_TARGET` if
needed. Hermes must accept the browser's Host/Origin and login callback location.
See [integration and deployment](docs/integration.md) for the routing details.

## Behavior and compatibility

Agora keeps access/refresh tokens in the local process's memory. Drafts,
transcripts, and unread markers are not persisted in browser storage. Hermes
retains saved conversation history. Local sign-out clears Agora's grants and
sockets; it does not end your identity provider's browser SSO session.

Losing a connection does not stop an agent. Agora recovers history and runtime
state before enabling actions. If a send's outcome is uncertain, it retains the
draft and asks you to check the conversation; it never automatically resends it.

Generated images load through Hermes's authenticated media routes. Remote-image
previews depend on Hermes's CDN allowlist. Background-task visibility depends on
the gateway's supported events and session-scoped roster.

The source-verified compatibility baseline is Hermes revision
[`e1fdf003a668f97bf5a53d7675c1e70b1dcfec34`](https://github.com/NousResearch/hermes-agent/tree/e1fdf003a668f97bf5a53d7675c1e70b1dcfec34).
Tests use synthetic Hermes responses; full authenticated live acceptance testing
is still pending. Check the [integration notes](docs/integration.md) when using a
different revision. Dashboard access is access to the operator's Hermes
installation; Agora does not provide independent per-user isolation.

## Further documentation

- [Product scope](docs/product.md)
- [Integration, authentication, and deployment](docs/integration.md)
- [Implementation handoff and upstream research](docs/implementation-handoff.md)
- [Contributor/agent instructions](AGENTS.md)
- [Upstream attribution](THIRD_PARTY_NOTICES.md)
