# Experimental mobile conversation drawer

**Trial only. Do not merge until physical iPhone acceptance passes.** The exact-left-edge gesture is explicitly approved as an experiment; it is not a verified suppression of iOS native Back. No authentication, installation, or backend configuration changes are required.

## Behavior and boundaries

- On Chat at widths up to 760px, the existing single conversation sidebar is teleported into a native modal dialog. The full-height left panel is 82vw, capped at 360px; the chat stays stationary behind a proportional dim backdrop. Other mobile selectors remain bottom sheets; desktop rail/sidebar geometry is unchanged.
- The header conversation-list button always works, including ordinary iOS Safari. Close, Escape, backdrop, and completed conversation selection dismiss the modal. New conversation is a full-width button. Search, pinning, grouping, activity/process/unread marks retain the existing state and components.
- One finger may open from the exact leftmost 20 CSS pixels. iOS/iPadOS edge opening is enabled **only in standalone mode**, including the iOS `navigator.standalone` fallback. Ordinary Safari retains native history behavior and button opening; swipe-to-close remains available.
- Touch start is passive. A temporary non-passive `touchmove` listener is registered only for an admitted start; it calls `preventDefault()` only after a 10px horizontal intent threshold and a 1.3 horizontal/vertical ratio. The bounded position follows the finger; release settles at half the drawer width. This intentionally does not cancel vertical or multi-touch gestures in an attempt to seize native history early. WebKit's native recognizer may still win.
- The closing gesture starts in the open modal, excluding text-entry controls. Vertical list scrolling and ordinary completed clicks remain native. Claimed drags suppress their compatibility click, but a fresh pointer/touch activation clears the suppression.
- Touch/pointer cancellation, a second finger, lost window focus, auth/profile/endpoint changes, another modal, view changes, breakpoint changes, and unmount clear the active sequence. Native cancellation returns to its initial open/closed state; context changes close it. Partial opening is already modal/inert: no chat click or Send may leak through.
- Reduce Motion removes automatic transform transitions, not direct finger following. Safe-area padding belongs to the drawer itself. No all-page cancellation or global overscroll policy is introduced.

## Physical acceptance gate — outstanding

Test the actual candidate build on the user's **iOS 27 installed PWA**, with Reduce Motion enabled, recording the interaction. Capture build identity, device/OS version, installation context, and outcome. Chromium platform spoofing/CDP only exercises application code, not UIKit/WebKit history arbitration.

1. Establish real back history by switching conversations, leaving/re-entering the app, and completing an authentication round trip where applicable. Do not test only a fresh history-free launch.
2. Start at the exact physical left edge: slow partial reveal, continue open, reverse, release before/after halfway, then swipe closed. Confirm continuous finger following and a stationary chat, with no native rounded live-view/snapshot behind it and no unexpected Back navigation.
3. Interrupt/cancel the gesture (including a second finger and app switch), then use header/Close/Escape where available/backdrop. No stuck dim surface, orphan modal, inert chat, or invisible input catcher may remain.
4. Scroll the conversation list vertically, search, pin/unpin, and select a conversation. Inspect running, waiting, unread and process marks beside action controls. No accidental selection, New conversation, Send/Steer, or Back may occur on press/drag/cancel.
5. Keep an unsent multiline draft plus image, inspect model/reasoning settings, open/cancel the drawer, visit Results/More/Memory/Jobs/Settings, then return. Draft/image and profile/runtime settings must retain their existing behavior. Check keyboard dismissal/restoration and top/bottom safe areas in portrait and landscape.
6. In **ordinary non-standalone Safari**, confirm no closed-drawer edge target is present, native Back still works, and header/Close fallback works. Check desktop browser rail/sidebar and bottom Settings gear, with no swipe capture zone.
7. If native Back wins or native and app gestures run concurrently, **do not merge**. Report the recording and choose a separately approved fallback or revised trial. Do not label synthetic checks as physical confirmation.

## Automated coverage

`nix develop path:. --command agora-check` runs typecheck, focused gesture/mounted integration regressions with the full Vitest suite, and production build. `scripts/mobile-navigation-smoke.mjs` remains the existing full-app fictional-fixture navigation/composer smoke. Disposable actual-CDP gesture evidence and its manifest live outside the repository; they are not production data or a shipped test framework.
