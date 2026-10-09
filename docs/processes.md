# Per-chat background processes

Agora shows owned shell processes beside pinned background tasks, above the composer. The process summary is collapsed by default. Each expanded row shows the command, elapsed runtime, status, a bounded output viewer, and an individual Stop button. The composer’s Stop still interrupts only the assistant turn.

## Wire contract

Checked against the installed Hermes `tui_gateway/contracts/tools_commands.py`, `methods_tools.py`, `server.py`, and `session_notifications.py`:

- `process.list`: `{ session_id: <runtime chat ID>, profile }`; the returned `processes[].session_id` is a **process ID**, not a chat ID.
- `process.kill`: `{ session_id: <runtime chat ID>, process_id, profile }`. Only `killed` and `already_exited` acknowledge termination. Errors retain the process; disconnects never automatically retry a kill.
- `agent.terminal.output`: session-addressed `{ process_id, chunk }`.
- `terminal.close`: session-addressed `{ process_id }`. This closes a terminal tab, **not necessarily its process**; Agora refreshes the roster instead of assuming an exit.
- `process.stop` is registry-wide and must never be used for this UI.

## Recovery and placement

Processes are cached reactively by stored chat ID and profile. They contribute to sidebar activity without changing foreground `running`, send availability, or approval state. Selected and known offscreen runtimes are polled every five seconds, including idle assistant sessions. Active-session discovery can recover unvisited offscreen chats in the discovered profile. Other profiles become discoverable through the existing session-selection/runtime mapping; this does not enumerate every profile’s runtime catalog.

Connection generations, per-scope request identity, and runtime replacement reject stale roster replies. Per-process revisions preserve newer live output while authoritative roster discovery and lifecycle updates still apply. Concurrent requests for one scope are coalesced. A slow offscreen read does not block the selected chat’s probe. Live and polled output retain only the final 4,000 characters per process.

Authoritative exit rows and successful individual kills produce compact, collapsed transcript results with exit information and output. Subsequent terminal snapshots can update the final output without reviving an exited process. Results observed in the selected chat keep an observation anchor; offscreen or initially recovered historical exits have no invented tail anchor and remain before loaded history. A durable `process_complete` notice with matching `display_metadata.process_id` supersedes the local result.

Disappearance from a successful roster is **unknown**, not successful completion. The last output remains inspectable in a status-unknown row, Stop is disabled, and process-derived sidebar activity clears. Recovered running status can restore that row. Unknown rows do not fabricate transcript completion notices.

Client-generated transcript results survive selection and reconnect within the current client. They are not written to browser storage or Hermes history. A full reload can only recover results still present in the process roster or durable Hermes history; a registry-pruned exit without durable history cannot be reconstructed.

## Verification

```sh
nix develop path:. --command agora-check
nix develop path:. --command npm test -- tests/chat-processes.test.ts tests/app.test.ts
AGORA_BROWSER_PATH="$(command -v chromium)" \
  AGORA_PROCESS_SCREENSHOT_DIR="$HOME/.hermes/cache/scratch/agora-process-smoke" \
  nix develop path:. --command node scripts/process-smoke.mjs
git diff --check
```

The browser smoke uses fictional HTTP/WebSocket fixtures, never production process data. It exercises desktop, mobile portrait, short landscape, long drafts and commands, pinned-task coexistence, live-output bounds, offscreen completion, and exact individual-kill payloads. It can also use a **Playwright-compatible Firefox executable** with `AGORA_BROWSER_ENGINE=firefox` and `AGORA_BROWSER_PATH`; ordinary system Firefox builds may lack Playwright’s protocol support. Passing the fixture checks is not proof of authenticated live-gateway acceptance or deployment.
