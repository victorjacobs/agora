# Agora

A focused chat client for [Hermes Agent](https://github.com/NousResearch/hermes-agent).
Run it on your laptop and connect to your own Hermes server, or host it alongside
the Hermes dashboard. Hermes runs the agent, stores conversations, and handles
sign-in. Agora provides the chat interface.

- Streamed replies, Markdown, code, and inline generated images.
- Memory view with saved notes, user preferences, soul and custom instructions,
  provider status, readable inline approvals, and staged-write previews.
- On-demand provider quota and credit balances, with a picker for multiple providers.
- A compact chat list grouped by date, with running and unread-reply indicators.
  Search loaded titles and stored message text; cron-job conversations are excluded.
- A conversation switcher on **⌘K / Ctrl+K**. Type to search, use ↑/↓ to choose,
  Enter to open, and Escape to close.
- Expandable tool activity and background-task progress, results, and errors.
  Running tasks stay above the composer; finished tasks remain in the transcript.
- Model and reasoning-effort choices scoped to each conversation.
- Slash commands with server-provided suggestions: type `/`, choose with ↑/↓ and
  Enter or Tab, add arguments, then send. Command output appears in the chat.
- Command approval cards with readable command text, **Allow once**, and **Reject**.
  Remembered approvals appear only when Hermes offers them. Clarification questions
  can be answered directly in chat.
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

Open **http://127.0.0.1:5173/** and click **Sign in with Hermes** if prompted.
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

Thinking appears as a collapsible item in the conversation. Open it to read the
reasoning text or summaries Hermes provides; some providers do not expose a trace.

Context compression shows a pinned spinner above the message box, including when
you run `/compress`. It clears when Hermes finishes or resumes normal work.

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

## Nix package and NixOS

Build or run the packaged application directly from the flake:

```sh
nix build github:victorjacobs/agora
HERMES_ENDPOINT=https://hermes.example.com nix run github:victorjacobs/agora
```

For a local checkout, use `nix build .` or `nix run .`. The package includes
Node.js and production dependencies. Open `http://127.0.0.1:5173/`.

To use Agora in a NixOS configuration flake:

```nix
{
  inputs.agora.url = "github:victorjacobs/agora";
  inputs.agora.inputs.nixpkgs.follows = "nixpkgs";

  outputs = { nixpkgs, agora, ... }: {
    nixosConfigurations.my-machine = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        ./configuration.nix
        agora.nixosModules.default
        {
          services.agora = {
            enable = true;
            hermesEndpoint = "https://hermes.example.com";
          };
        }
      ];
    };
  };
}
```

Add these entries to your existing configuration flake, which must already
declare `inputs.nixpkgs`. The module builds Agora with your system's Nixpkgs.
Its service listens on loopback for a browser on that machine.

Exports are `packages.<system>.default` (also named `agora`) and
`nixosModules.default` (also named `agora`). The implementations remain in
[nix/package.nix](nix/package.nix) and [nix/module.nix](nix/module.nix), which can
also be imported directly. See [Nix packaging and NixOS](docs/nix.md) for profile
overrides, service options, and serving the packaged static files.

## Host alongside Hermes

For a static deployment, omit `HERMES_ENDPOINT` when building:

```sh
npm run build
```

Serve `dist/` at `/` on your HTTPS domain, for example `https://agora.vjcbs.be/`.
Proxy `/api/*`, `/login`, and `/auth/*` to Hermes, including WebSocket upgrades.
Keep these routes ahead of the UI's SPA fallback. The static UI uses Hermes's
browser login and session cookies directly; it does not need the local service.
Configure Hermes to accept this public origin and its OIDC callback at
`https://agora.vjcbs.be/auth/callback`; serving static files alone is not enough.

For development in this mode, omit `HERMES_ENDPOINT` and set `HERMES_TARGET` if
needed. Hermes must accept the browser's Host/Origin and login callback location.
See [integration and deployment](docs/integration.md) for the routing details.

## Behavior and compatibility

Agora keeps access/refresh tokens in the local process's memory. Drafts,
transcripts, and unread markers are not persisted in browser storage. Hermes
retains saved conversation history.

Losing a connection does not stop an agent. Agora recovers history and runtime
state before enabling actions. If a send's outcome is uncertain, it retains the
draft and asks you to check the conversation; it never automatically resends it.

Generated images load through Hermes's authenticated media routes. Remote-image
previews depend on Hermes's CDN allowlist. Background-task visibility depends on
the gateway's supported events and session-scoped roster.

Provider quota is available in the sidebar footer. Choose a provider to see its
remaining limits, reset times, or credit balance. Agora queries Hermes’s read-only
`hermes usage --provider … --json` command through the gateway; credentials stay
on Hermes. Providers without a quota endpoint, or older Hermes versions without
this command, show quota as unavailable. Checking quota does not change the chat’s
model or start an agent turn.


The source-verified compatibility baseline is Hermes revision
[`e1fdf003a668f97bf5a53d7675c1e70b1dcfec34`](https://github.com/NousResearch/hermes-agent/tree/e1fdf003a668f97bf5a53d7675c1e70b1dcfec34).
Tests use synthetic Hermes responses; full authenticated live acceptance testing
is still pending. Check the [integration notes](docs/integration.md) when using a
different revision. Dashboard access is access to the operator's Hermes
installation; Agora does not provide independent per-user isolation.

Memory review is available from the Memory icon in the left rail. Inline
approval cards show the change and offer **Save this change** or **Reject**.
The view also loads staged-write previews for the selected conversation’s profile.
Hermes currently truncates staged proposals and does not expose a full review API,
so Agora shows those as previews without approval buttons. No Hermes patches,
internal-file access, or changes to the memory approval policy are required.

The same sidebar includes **Saved memory**, **User profile**, **Soul & instructions**,
and **Memory providers**. These show the selected conversation's
profile (or Hermes's current profile when no conversation is selected). Open a
saved entry to load its complete text; the list shows previews. Use **Edit** to
change the text or **Delete** to review and confirm removal. Changes go directly
to Hermes and refresh the list after success; unsupported writes show an error.
Soul, instructions, and provider status remain read-only. External memory
providers may hold additional data that Hermes's built-in memory APIs do not
expose. Unsupported sections show their error without blocking the others.
Inspection loads on opening a section or clicking Refresh, with no background
polling or browser persistence.

## Further documentation

- [Product scope](docs/product.md)
- [Integration, authentication, and deployment](docs/integration.md)
- [Implementation handoff and upstream research](docs/implementation-handoff.md)
- [Contributor/agent instructions](AGENTS.md)
- [Upstream attribution](THIRD_PARTY_NOTICES.md)
