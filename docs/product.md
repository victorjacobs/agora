# First-version scope

## Required outcome

A user signs in through the Hermes dashboard's OIDC flow, opens or creates a
session, sends a message, sees the reply arrive, and returns later to continue
the same conversation. Hermes is the source of truth throughout.

## Core interface

- Session list ordered by recent activity, with loading, empty, and error states
  and a way to load more. New chat, open/resume, rename, and confirmed delete.
- Conversation view with user/assistant messages, readable Markdown and code
  blocks, and compact tool activity. Load older history without fetching every
  conversation in advance.
- Text composer with send and stop controls. Keep an unsent draft during a
  temporary disconnect; show sending, running, reconnecting, and failed states.
- Explicit controls for agent approval/clarification requests needed to finish
  an ordinary chat. Show unsupported requests clearly; never silently accept them.
- Login/logout and a clear expired-session state. Preserve the selected
  conversation across login and reload using a stable URL where practical.
- Responsive layout, keyboard-accessible controls, visible focus, and sensible
  scrolling that does not drag a reader away from older messages.

Session deletion must use the upstream API and display upstream failures. Keep
selection, history, and live events associated with the correct session when
switching quickly. On reconnect, recover the server's state before enabling more
actions; losing a socket does not mean the agent stopped.

## Suggested defaults

One configured Hermes server and one configured/default profile per deployment.
Use Hermes's configured model and agent settings. Disable ordinary send while a
turn is active in v1 rather than adding a queue/steering UI. Still handle busy
states returned by Hermes, including work started from another client.

## Deferred

Multiple-server/profile management, model/provider settings, prompt editing or
branching, attachments, voice, terminal/file browser, tasks/boards, cron, skills,
MCP management, analytics, notifications, offline mode, and custom account
management. No feature parity with Hermes's dashboard, Conduit, or hermes-webui.

## Acceptance

With a real OIDC-enabled Hermes dashboard, a user can sign in, create a chat,
stream a reply, stop a turn, answer an approval/clarification, resume after a
reload, rename/delete a session, and log out. A dropped connection or expired
login produces a recoverable state without duplicated prompts or messages.
No Agora process needs the Hermes home directory or database mounted.
