# Server-backed chat pins

Pins use Hermes's native `pinned` session flag, not an Agora database. Pin/unpin
sends `PATCH /api/sessions/{id}` with **only** `{pinned, profile}`; the response
must confirm `{ok: true, pinned}` and a subsequent detail read must confirm the
flag. A failed or unconfirmed action rolls back the optimistic indicator and
shows a retryable error. No chat title or message is migrated.

Pins are shared by clients accessing the same Hermes endpoint and profile,
**not private to an individual login**. Native pins also exempt chats from
Hermes's automatic archive sweep. Another client's changes appear after reload,
reconnect, browser focus/visibility recovery, or **Retry pins**; there is no
pin-change push subscription or continuous polling.

## Automatic migration

Existing `agora.pinned-conversations` references remain visible while Agora
imports them. Migration waits for the authenticated gateway to be ready and a
resolved Hermes endpoint and profile. A transient bridge-discovery failure never
falls back to importing an unrelated browser-origin backup. An omitted profile
is resolved through `/api/profiles/active`; references for other profiles and
endpoints are left intact until those scopes are visited.

Each entry is handled independently:

1. Read that chat's native flag. Preserve any existing server-only pins.
2. Persist a temporary `migrationAttempted: true` marker on that reference in
   the **existing** backup key before the potentially ambiguous operation.
3. Send `pinned: true` only when needed; never send `false` during import.
4. Validate the response and read the exact target back. Only then remove that
   one local reference. A confirmed 404 may also remove a missing reference;
   authentication/network/server errors never discard it.

The temporary marker and reference disappear together after acknowledgement;
there is no permanent local pin set or global migrated flag. If browser storage
cannot be read or written, Agora keeps the backup, reports the permission/storage
problem, and blocks unsafe migration/unpin changes to those legacy entries.
Already-confirmed imports retry acknowledgement rather than sending `true` again.
If a page closes during an uncertain import and the server is now unpinned,
Agora cannot distinguish a failed import from another client's intentional
unpin: it keeps the reference pending. **Retry pins** only reconciles this state;
it never replays an uncertain pin write. A separate **Import old pins** action
asks for confirmation before pinning those chats again, including chats unpinned
on another device. **Unpin chat** accepts the server's unpinned state instead.
Entries that failed
before a write attempt can retry automatically on reconnect.

An active per-chat write disables its pin control (including known compression
aliases) with a saving state. Queued imports recheck whether the reference still
exists, so unpinning a different pending entry cannot be overwritten by a late
import. Reconnecting during a pre-write read resumes automatic import when the
obsolete operation releases its lock. Scope changes and logout invalidate late client-side settlement. Requests
already accepted by Hermes cannot be cancelled; independent clients still have
ordinary last-write-wins semantics, not a distributed transaction.

## Verified upstream contract

Checked against the installed Hermes source package
`/nix/store/irk3f7z9n1mpl427rpiks2i81zh198s2-hermes-agent-0.0.0`,
not against a private/live session DB; the deployed server revision is unverified:

- `hermes_cli/web_routers/sessions.py`: native PATCH flag update, profile ownership
  on detail reads, and boolean flags in session lists. Detail flags may be SQLite
  `0`/`1`; Agora accepts those as well as JSON booleans.
- `hermes_state_sessions.py`: pin updates cover the compression lineage. Projected
  list rows expose the live tip plus `_lineage_ids`; Agora uses only that explicit
  metadata to collapse an older root/middle reference, never title/parent guesses.
- The list API backfills all eligible native pins after its limited SQL window.
  It may return more than 20 rows, including archived pins outside `total`.
  Agora advances its recent-list cursor using returned `offset + limit` (20 as
  the compatibility fallback), not displayed/deduplicated row counts. Backfill
  rows do not hide Load more or skip recent chats.

A Hermes version without native pin metadata/update support leaves migration
pending with an error; Agora does not invent an endpoint or replace server pins
with browser state. Hidden/source-filtered native chats remain subject to the
server's list policy. This does not change delegated-session classification.

## Verification

Focused API/hook/component tests cover additive migration, partial acknowledgement,
readback failures, missing chats, storage failures including reload ambiguity,
endpoint/profile changes, queued unpin races, compression identity, focus recovery,
selected-header state and native-backfill pagination. Bridge tests confirm the
existing authenticated PATCH forwarding and Origin checks; no bridge expansion
is needed.

Run the actual Vue application with fictional fixtures and two independent browser
contexts:

```sh
AGORA_BROWSER_PATH=/path/to/chromium \
AGORA_EVIDENCE_DIR=/path/to/scratch/evidence \
  nix develop path:. --command node scripts/server-pins-smoke.mjs
```

The script checks automatic migration/reload, a second client's unpin, independent
server-flag changes, and a retained older pin through 503/reload/retry. It writes a
JSON report and a synthetic-data screenshot to the requested scratch directory.
This is browser-fixture evidence, not live authenticated Hermes/OIDC or physical
mobile-device acceptance. No Hermes database, session files, or credentials are
read or modified by these checks.
