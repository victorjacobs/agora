# Background Web Push

Web Push is opt-in per device, using the existing Agora login—no pairing or new
identity provider. It requires the Node bridge, a stable VAPID secret, HTTPS
(or localhost for development), browser permission, and a supported browser push
service. A static frontend pointed directly at Hermes cannot run the background
observer. No paid relay or Apple developer membership is required.

## On your device

1. Sign in to Agora normally. On iPhone/iPad (16.4 or later), use **Share → Add to
   Home Screen**, then open that installed app. Android users can also install
   Agora from the browser's install menu.
2. Open a conversation, then open **More → Settings** on mobile or the
   bottom-gutter **Settings** cog on desktop. Tap the **Notifications** control
   showing **Notifications off**. Permission is requested from that tap, not automatically.
3. Allow notifications. **Background notifications on** means this device is
   subscribed. Notification **Details** reports the observer's last checked state; focus or
   reopen Agora to refresh it. An unavailable/reconnecting watcher is not a
   delivery guarantee. Disable using the same control.

Only conversations actually opened or created in this Agora login are watched
(up to 64; oldest registrations are replaced). Other unopened Hermes chats and
individual child-task/process completions are not included. Replies, approvals,
clarification questions and secure-input requests can notify, including while
Agora is visible. Existing desktop completion notifications are suppressed for a
push-enabled device. With Web Push unavailable, desktop-only notifications retain
their old open-and-connected limitation; mobile browsers do not pretend that the
desktop `Notification` constructor works.

Notifications may show the conversation title and a short plaintext reply or
question preview on the lock screen. Sudo, vault and secret-input notifications
always have a generic title/body: no commands, origins, password hints, typed
credentials or verification codes. Approval bodies are generic too. Reply previews
remove common Markdown/media paths and URLs, but **are not a secret detector**;
an assistant's ordinary answer or conversation title can itself contain sensitive
text. Disable notifications or hide lock-screen previews in device settings if
that is unsuitable. Tapping only opens the conversation/profile, never answers or
approves anything. Unlocking/signing in remains necessary to read the chat.

## Operator setup

From the Nix development shell, after `npm ci`, create a private key file once:

```sh
node scripts/push-vapid.mjs /private/operator/path/agora-vapid.json mailto:operator@example.com
```

The parent directory must already exist and be private. The command writes mode
`0600`, refuses to overwrite an existing file, and never prints the secret. The
JSON contains `publicKey`, `privateKey` (base64url P-256) and `subject` (a real
operator `mailto:` or HTTPS contact). Preserve this key across restarts. Do not
commit it, build it into a frontend, put its contents in Nix expressions/store
paths, or include it in ordinary session-cache backups. Provision it through the
operator's existing secret mechanism. Changing keys requires devices to disable
and re-enable notifications.

Set `AGORA_PUSH_VAPID_FILE` to its runtime path, then start Agora normally. Leaving
it unset disables Web Push; malformed or mismatched keys fail startup. The secret
is read only by the Node service; the browser gets only the public key.

NixOS:

```nix
services.agora = {
  enable = true;
  hermesEndpoint = "https://hermes.example.com";
  publicOrigin = "https://agora.example.com";
  pushVapidFile = "/run/secrets/agora-push-vapid";
};
```

`LoadCredential` copies that runtime file into the service's protected credential
directory. The module does not generate secrets or read their contents at Nix
evaluation time. The packaged helper is at
`<package>/share/agora/scripts/push-vapid.mjs` and can be run with the Nix shell's
Node. Provision the file and operator contact before activation. Hosted login
still has the existing Hermes callback-allowlist prerequisite; push does not
change authentication or require any additional Hermes patch.

Keep `/sw.js` served as JavaScript from the Agora root, without immutable caching,
and proxy `/api/agora/push` to Agora, not Hermes. This is a push-only service worker:
no fetch handler, offline cache, authenticated background fetch, or stale app shell.
Outbound HTTPS is needed for the configured Hermes endpoint and allowlisted
Apple (`*.push.apple.com`), Google (`fcm.googleapis.com`) and Mozilla
(`updates.push.services.mozilla.com` and regional `*.push.services.mozilla.com`)
providers. Other providers—including Windows WNS—are deliberately unsupported,
not an excuse to permit arbitrary server-side URLs. Subscriptions must use HTTPS,
port 443, no URL credentials or fragments, and valid P-256/auth keys. Redirects
are not followed. Delivery has four concurrent slots, a bounded queue and total
network timeout; provider response bodies are bounded and never logged.

## Storage, lifecycle and protocol

The approved notification-metadata exception extends Agora's existing private
SQLite login cache with two tables: auth-bound encrypted-delivery subscriptions
(endpoint and browser public/auth keys), and watched runtime/stored/profile IDs,
replay epoch/sequence, and bounded SHA-256 dedupe identifiers. Browser cookies
remain hashed identifiers. There is **no notification transcript**, persisted
conversation title, message body, command, input answer, or pending payload outbox.
Tokens and subscription metadata are plaintext at rest in the private `0600`
cache; protect the host and exclude it from normal backups. SQLite foreign-key
cascades remove associated metadata on logout, idle pruning or definitive native
refresh rejection. `:memory:` explicitly forfeits restart persistence.

The bridge observes successful actual browser `session.create`/`session.resume`
responses to learn exact mappings: create/unpersisted drafts return
`stored_session_id`; cold, deferred and live resumes return `session_key`.
`info.profile_name` wins over the open request's profile; an unknown profile is
not guessed. The observer does not trust submitted browser titles or
invent runtime IDs. An observer is restarted only for logins with subscriptions,
reusing that login's single `NativeSession` and token-refresh single-flight. Token
rotation and observer sockets never advance the rolling idle deadline. Identity
is checked periodically (about 30 seconds while connected) and again before
sending; local logout immediately prevents new dispatch, and definitive upstream
401/refresh rejection removes the login. Expiry also prevents dispatch before the
next periodic cleanup. Disabling removes just this device; other devices in the
same login may remain subscribed (eight-device limit).

The passive socket uses a fresh `POST /api/auth/ws-ticket`,
`hermes-gateway-v1` plus `hermes-gateway-ticket.<ticket>`, waits for
`gateway.ready`, and reuses Agora's gateway heartbeat/framing implementation.
It calls only `session.events.since` (`session_id`, `last_seen`, exact `profile`)
and `gateway.ping`. It never resumes/activates a session, advertises itself as an
interactive renderer, submits prompts, reads Hermes storage, lists active
sessions to infer ownership, or acknowledges/answers requests. Titles come from
the authenticated public session HTTP endpoint, in memory at delivery time.

Inspected Hermes source: revision `d526f14714ce8a95cafd7f3a95d1eab5b6e0b910`,
`tui_gateway/methods_session.py:2599–2613`, `contracts/sessions.py`,
`contracts/events.py`, `contracts/server_requests.py` and `server.py:_open_requests`.
`message.complete` with no error and `status: complete` (or legacy absent status)
is eligible. Current `open_requests` supply the actual approval, clarify, sudo and
vault request shapes. Unsupported replay contracts produce an unavailable watcher,
not an execution-based fallback.

The observer bounds each entire WebSocket message to 16 MiB + 64 KiB
(16,842,752 bytes), not the upstream ring's 4 MiB accounting budget. Hermes
accounts compact UTF-8 event objects before adding sequence fields; the transport
uses non-compact JSON. Three times that event budget covers whitespace and even
ASCII-escaped Unicode serialization, with 64 KiB for up to 512 sequence fields
and the RPC envelope. Another 4 MiB is reserved for serialized `open_requests`.
Hermes currently has **no size/count bound** on that separate collection, so this
is an explicit client resource policy, not a guarantee to accept every possible
upstream response. Larger frames fail closed without advancing that watch.

Watch read/processing failures use an in-memory, at-most-64-entry backoff map
(6 seconds doubling to 60 seconds). Stable round-robin position survives socket
reconnects independently of SQLite row order, so one unavailable, oversized or
malformed watch cannot repeatedly lead a sweep and starve other chats. Such
failures leave its persisted replay cursor/dedupe unchanged; title/auth processing
must succeed before delivery reservation. No payloads are kept for retries.
Definitive login revocation still stops the entire observer; ordinary watch
failures do not revoke the login or trigger execution-based recovery.

## Delivery limits and acceptance

This is **best-effort**, not a durable message queue. Initial registration starts
at the current replay watermark; no old replies or already-pending requests are
announced. The installed Hermes replay ring is finite and in process memory.
Across an Agora restart the persisted cursor resumes the same epoch without
repeating deliveries; a Hermes epoch change or truncated replay rebaselines rather
than inventing missed notifications. After a Hermes restart, reopen chats to
establish any changed runtime IDs; this observer cannot resurrect sessions. The
first baseline can also miss a completion during initial watcher setup. Dedupe is reserved before sending to avoid
restart duplicates without storing content. A crash, provider failure or a burst
over the bounded limits can lose notifications; there is no durable retry outbox.
404/410 subscriptions are removed; transient provider failures retain the
subscription for future events. Polling normally adds about three seconds,
reconnection uses bounded backoff, and push TTL is 120 seconds. Mobile OS power,
Focus and notification settings can delay or suppress delivery.

This passive observer does not keep an interactive renderer attached. Hermes may
not create new interactive prompts after its last capable viewer disappears.
Attention push is possible only when Hermes exposes an actual pending request;
physical-device detached-prompt acceptance remains unverified. Notifications do
not extend Hermes's sudo timeout (currently 120 seconds), transfer request
ownership or keep the login alive forever. Logout cannot recall a payload already
accepted by a push service or OS; it stops subsequent dispatch and closes displayed
notifications when the browser is available. Browser subscription rotation may
require reopening/re-enabling Agora.

Validation commands:

```sh
npm run typecheck
npm test
npm run build
node tests/session-runtime.mjs
AGORA_BROWSER_PATH=/path/to/chromium node scripts/push-smoke.mjs
```

The real Node-process fixture uses synthetic PKCE, actual WebSockets, SQLite,
restart/token rotation and encrypted `aes128gcm` delivery decrypted by a loopback
receiver; only the provider network transport is redirected inside the fixture.
Browser evidence uses the actual Vue app and service worker/native
`showNotification`, with CDP injecting a push event; the PushManager subscription
adapter is explicitly synthetic. VM tests cover safe warm/cold click routing.
These do not establish real APNs/FCM registration, physical iOS delivery or a live
Hermes/OIDC deployment. Complete an installed-phone enable → closed-app reply →
tap → pending request → disable/logout acceptance after provisioning real keys.

Primary references:
- [WebKit: Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [web-push library](https://github.com/web-push-libs/web-push)
