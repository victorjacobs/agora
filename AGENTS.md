# Agent instructions

## Project

Agora is a small Vue web chat client for the built-in Hermes manage/dashboard
server. Read [README.md](README.md), [docs/product.md](docs/product.md), and
[docs/implementation-handoff.md](docs/implementation-handoff.md) before implementing.
The handoff links verified upstream sources and distinguishes requirements from
suggestions and unresolved details. Recheck them against the target Hermes version.

- Use Vue with TypeScript and Vite. Use Nix and direnv for development.
- Connect directly to Hermes dashboard HTTP APIs and its chat WebSocket protocol.
  Hermes owns agent execution, sessions, history, configuration, and authentication.
- Never read or write Hermes SQLite, session files, or other internal storage.
  Do not depend on hermes-webui or create a second agent backend or database.
- Hosted mode uses Hermes's browser OIDC flow and session cookies. Laptop mode
  uses Hermes's native PKCE flow through a loopback-only local service configured
  by HERMES_ENDPOINT. Keep native tokens in server memory, outside the browser.
  Do not create an Agora identity store or independent authentication provider.
- Keep v1 focused on chat and sessions. Do not reproduce the management dashboard.
- Treat dashboard access as access to the operator's Hermes installation; do not
  claim per-user isolation that the upstream APIs do not guarantee.
- Keep protocol/auth code outside Vue components. Inspect upstream contracts and
  reusable client code before inventing a transport. Check licensing before reuse.
- Preserve runtime versus stored session IDs and profile context. Do not guess
  field names, request parameters, event envelopes, or retry semantics.
- Never automatically resend a prompt after an ambiguous connection failure.
  Never auto-approve tool execution or answer a user prompt silently.
- Render message content safely; no unsanitized HTML. Do not log credentials,
  tickets, or conversation contents, or persist them in browser storage by default.

## Development

- Keep tooling and common developer commands in the flake. Add tooling there
  before using it; no ad hoc global installs in setup instructions.
- Maintain flake.lock and the chosen application dependency lockfile. npm is the
  initial package-manager suggestion, following ~/dev/tob.
- The existing shell is intentionally small. Add working development/check
  commands when application scripts exist; do not document imaginary commands.
- Prefer descriptive names and existing patterns. Comments explain non-obvious
  reasons, not what the next statement does.
- Verify relevant type checks, tests, and production build when code exists.
  Test protocol state transitions, reconnects, and auth failures meaningfully.
  Record limitations when live Hermes/OIDC validation is unavailable.
- Keep docs aligned with implementation. Do not turn an unresolved API detail
  into a product requirement without evidence.

## Communication and Git

- Be terse and direct; no praise, filler, or canned acknowledgements.
- Research uncertainty first; then report concrete findings and remaining choices.
  Say directly when a link cannot be accessed.
- Do not commit or push without an explicit request. Never amend commits.

## Go, if introduced later

Go is not part of the selected application stack. If later authorized, follow
surrounding patterns; use struct-literal interface assertions such as
`var _ io.Writer = &outputWriter{}`. Separate logical blocks with blank lines,
handle errors explicitly, use gofmt/goimports, and run `go build ./...` and
`go test ./...` (or the relevant package).
