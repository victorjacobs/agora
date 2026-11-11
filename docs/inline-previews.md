# Inline HTML previews

An assistant can include this exact standalone line in a reply:

```text
::preview{file="~/charts/example.html"}
```

Use a local absolute path or `~/` path ending in `.html` or `.htm`. Spaces in
filenames work. Remote URLs, protocol-relative paths, backslashes, control
characters, percent-encoded paths, queries/fragments and `.`/`..` path segments
are rejected. Canonical syntax uses double quotes, no spaces around `::preview`
or `file=`, and no leading indentation. Fenced, indented and inline code,
blockquotes, user messages, tool output and reasoning stay literal. Incomplete
streamed directives stay text until the closing `}` arrives. At most four
previews render per message; further directives remain visible as text.

The file is fetched only when that reply is rendered, using the existing
authenticated `/api/fs/download?path=…&profile=…` route and selected profile.
There is no new Hermes endpoint or backend storage. Missing/expired files and
expired authentication show an error, an explicit Retry button, and the original
Download link. Responses are bounded to 2 MiB of actual received bytes and a
15-second fetch timeout. A profile/path change clears the old frame before the
next render and aborts the obsolete request; late responses cannot replace the
new content. Appending streamed text retains an existing preview and does not
fetch it again. Reloading history fetches again; HTML is not persisted or cached
by Agora. Expanded views reuse the downloaded document but execute a fresh
isolated frame, so widget state is not shared with the inline view.

## Self-contained documents and themes

Use inline CSS, inline JavaScript, SVG, canvas, and embedded `data:` images.
External scripts, CDN libraries, fonts, stylesheets, images and HTTP API requests
are not supported. Bundle chart code into the file instead. Use system fonts.
Agora supplies these CSS variables, with updates when appearance changes:

- `--foreground`
- `--muted-foreground`
- `--accent`
- `--border`
- `--card`

The defaults use Agora's system font, foreground and card background. The document
can use its own layout/styles. Reduced-motion preferences disable CSS animations,
transitions and smooth scrolling; generated JavaScript must also respect the
browser's reduced-motion media query for its own animation loops.

## Isolation boundary

The ordinary Markdown sanitizer is unchanged. A directive creates a Vue-owned
iframe; arbitrary iframe markup in Markdown never becomes a preview. Raw
downloaded HTML is never assigned a same-origin iframe `src` or opened in an
unsandboxed tab. **Download** explicitly saves the original file; opening that
download outside Agora is outside this sandbox.

Every preview, including expanded views, uses `sandbox="allow-scripts"` without
same-origin, forms, popups, downloads, or top-navigation permissions. The opaque
origin cannot access the parent document, cookies or storage. Before loading,
Agora parses the document inertly, removes existing base/meta/link elements,
frames/objects/embeds/forms, external scripts, and navigable link attributes, and
prepends a restrictive CSP before any generated content. It allows inline CSS/JS
and data images, but denies connections, external resources, frames, objects,
workers, forms and base URLs. Existing hostile policies/refreshes cannot precede
or replace it.

**Child CSP alone does not stop script-driven self-navigation.** Agora therefore
also places a narrow `frame-src 'none'` CSP on the parent page in `index.html`.
Inline `srcdoc` frames are allowed; their navigation to HTTP(S), including Agora's
own authenticated API URLs, is blocked before a network request. Do not remove
this policy to enable a third-party embedded frame. The preview component fails
closed if the required parent policy element is missing. Deployments must serve
the built `index.html`, not replace its security metadata with a custom shell.

The only child-to-parent message accepted is a finite numeric resize from that
specific inline iframe's `contentWindow`. Height is clamped to 160–720 px; long
documents scroll within the frame or use Expand. A child can lie about its own
height but cannot resize arbitrary frames, expand a dialog, submit chat text,
answer input/approval prompts, or run parent actions. `hermes.send` and
`data-hermes-send` are deliberately unsupported. Theme messages contain only
appearance variables, never conversation data or credentials.

This is browser document isolation, not a CPU/memory/process sandbox: an inline
script can still hang its own renderer or allocate memory. Do not preview
untrusted third-party programs expecting an OS-level containment boundary.

## Verification

Run from `nix develop path:.` after `npm ci`:

```sh
npm test
npm run build
AGORA_BROWSER_PATH=/path/to/chromium \
  AGORA_EVIDENCE_DIR="$TMPDIR/agora-preview-evidence" \
  node scripts/inline-preview-smoke.mjs
```

The smoke harness serves the actual Vue app with fictional HTTP/WebSocket data,
not a mockup or live Hermes installation. It captures desktop/mobile light/dark
and expanded views, exercises generated inline JavaScript, downloads exact
original HTML, checks missing-file retry, real streamed directives and code copy,
and attacks parent DOM/storage/cookies, fetch/image/popup/top-navigation and
script-driven self-navigation to both an external exfiltration fixture URL and
same-origin `/api/auth/logout`. Route interception must see **zero** attempted
requests for those blocked destinations; explicit CSP violations must confirm
the self-navigation attempts executed. Evidence includes screenshots, SHA-256
digests, browser version, assertions and error/request lists.

Validated in installed Chromium; Firefox, WebKit/physical mobile devices and live
authenticated Hermes acceptance remain unverified. Re-run the isolation probes
for target browser engines before claiming broader security compatibility.