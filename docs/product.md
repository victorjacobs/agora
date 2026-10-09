# First-version scope

## Required outcome

A user signs in through the Hermes dashboard's OIDC flow, opens or creates a
session, sends a message, sees the reply arrive, and returns later to continue
the same conversation. Hermes is the source of truth throughout. Agora can run
on a laptop and connect to a remote Hermes endpoint configured in `.env.local`;
Hermes does not need to host the UI. A production Node bridge can also serve
Agora behind an HTTPS reverse proxy using AGORA_PUBLIC_ORIGIN; hosted login
requires an operator-maintained Hermes HTTPS callback allowlist patch. Native
desktop packaging is deferred.

## Core interface

- Session list ordered by recent activity, with loading, empty, and error states
  and a way to load more. New chat, open/resume, rename, and confirmed delete.
  Show a running indicator and distinguish sessions waiting for input.
  Local pins keep selected conversations above date groups; store only session
  IDs and profiles, scoped to the Hermes endpoint, without changing Hermes.
- Conversation view with user/assistant messages, readable Markdown and code
  blocks, and compact tool activity. Load older history without fetching every
  conversation in advance.
- Text composer with send and stop controls. Keep an unsent draft during a
  temporary disconnect; show sending, running, reconnecting, and failed states.
- Memory workspace with pending-update review, inspection and explicit editing/deletion
  of saved notes and user-profile entries, and read-only soul/instructions and
  memory-provider status exposed by Hermes.
- Results workspace between Chats and Memory with All results selected initially.
  Individual sidebar jobs filter a chronological output feed; no duplicate job
  dropdown. Render actual assistant output with safe Markdown, not run titles.
  Group visible runs by their local calendar day, with dated Today/Yesterday
  headings and horizontal divider lines. Card headings and footer actions carry
  decorative document/settings icons; run times use readable relative-day labels.
  Running, Finished and Unknown describe per-run evidence; Finished does not imply
  success. Never apply a job’s latest status to older runs. Script-only runs show
  API previews with their full-output limitation. Conversations and older history
  load on demand, read-only. Manage job opens the exact Cron job after loading.
  Limit the feed to recent runs supported by Hermes, with bounded output pages
  and concurrent reads; refresh only an active, connected, visible workspace.
- Cron workspace for creating/editing jobs, pause/resume, confirmed manual runs
  and deletion, and read-only recent run history through the dashboard APIs.
- Passwords & Logins workspace for profile-scoped metadata search, explicit
  additions and confirmed local removals through Hermes's existing vault RPCs.
  Source readiness is read-only. No password reveal, editing, payment/address
  management, manager configuration/unlock, browser control, or vault storage in Agora.
- Explicit controls for agent approval/clarification requests needed to finish
  an ordinary chat. Show unsupported requests clearly; never silently accept them.
- Login/logout and a clear expired-session state. Preserve the selected
  conversation across login and reload using a stable URL where practical.
  Signed-out users see a dedicated sign-in screen with
  one prominent sign-in action; connection errors remain visible there.
- Opt-in desktop completion notifications while Agora is open, connected, and
  unfocused, with no conversation content in notifications. No background push.
- Responsive layout, keyboard-accessible controls, visible focus, and sensible
  scrolling that does not drag a reader away from older messages.

Session deletion must use the upstream API and display upstream failures. Keep
selection, history, and live events associated with the correct session when
switching quickly. On reconnect, recover the server's state before enabling more
actions; losing a socket does not mean the agent stopped.

## Suggested defaults

One configured Hermes server and one configured/default profile per deployment.
Use Hermes's configured model and agent settings. While a turn is active, expose
text-only steering through `session.steer`; keep Stop available. Do not silently
fall back to a new prompt or retry an uncertain steer. Still handle busy
states returned by Hermes, including work started from another client.

## Deferred

Multiple-server/profile management, global model/provider settings, prompt editing or
branching, non-image attachments, voice, terminal/file browser, tasks/boards, skills,
MCP management, analytics, closed-app push notifications, offline mode, and custom account
management. No feature parity with Hermes's dashboard, Conduit, or hermes-webui.

## Acceptance

With a real OIDC-enabled Hermes dashboard, a user can sign in, create a chat,
stream a reply, stop a turn, answer an approval/clarification, resume after a
reload, rename/delete a session, and log out. A dropped connection or expired
login produces a recoverable state without duplicated prompts or messages.
No Agora process needs the Hermes home directory or database mounted.

In-chat background activity includes a delegated-task panel with goals, lifecycle
status, model, tool activity, and expandable results or errors. Task completion
notices in stored history are distinguished from user messages.
Running tasks stay pinned above the composer while the transcript scrolls.
When a task finishes, its card is placed at that point in the conversation.

The composer offers model and reasoning-effort choices for the current session.
Hermes supplies the model inventory and remains authoritative for applied
settings. Guarded model switches require explicit confirmation.
