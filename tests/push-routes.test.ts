// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import webpush from 'web-push'
import { HermesBridge } from '../server/bridge.ts'

let bridge: HermesBridge
// Exercise the bridge's metadata tap without creating an observer or an execution-capable client.
afterEach(() => bridge?.dispose())
function fixture() {
  bridge = new HermesBridge('http://127.0.0.1:9', fetch, { push: { ...webpush.generateVAPIDKeys(), subject: 'mailto:fixture@example.test' } })
  const internal = bridge as any
  const session = { routes: new Map(), sockets: new Set(), native: { dispose() {} } }
  internal.sessions.set('owner', session)
  const pending = new Map()
  return { session, open(method: string, profile: string | undefined, result: object) {
    internal.observeRoutes('owner', session, JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { profile } }), pending, true)
    internal.observeRoutes('owner', session, JSON.stringify({ jsonrpc: '2.0', id: 1, result }), pending, false)
  } }
}
it('retains fresh create and live unpersisted draft resume routes with upstream default profile', () => {
  const { session, open } = fixture()
  open('session.create', undefined, { session_id: 'fresh-runtime', stored_session_id: 'fresh-key', info: { profile_name: 'launch-profile', lazy: true } })
  open('session.resume', 'wrong-request-profile', { session_id: 'draft-runtime', stored_session_id: 'draft-key', messages: [], info: { profile_name: 'launch-profile', lazy: true } })
  expect([...session.routes.values()]).toMatchObject([
    { runtime: 'fresh-runtime', stored: 'fresh-key', profile: 'launch-profile' },
    { runtime: 'draft-runtime', stored: 'draft-key', profile: 'launch-profile' },
  ])
})
it('registers actual cold, deferred and live resume session_key while preserving exact routing metadata', () => {
  const { session, open } = fixture()
  open('session.resume', 'work', { session_id: 'cold-runtime', session_key: 'canonical-cold-key', resumed: 'canonical-cold-key', messages: [], info: { profile_name: 'work' }, running: false })
  open('session.resume', 'work', { session_id: 'deferred-runtime', session_key: 'canonical-deferred-key', resumed: 'canonical-deferred-key', hydrating: true, messages: [], info: { profile_name: 'work' } })
  // _fallback_session_info for a reused lazy session has no profile_name: the authenticated open request owns it.
  open('session.resume', 'Work exact', { session_id: 'live-runtime', session_key: 'live-key', resumed: 'live-key', messages_omitted: true, info: { lazy: true } })
  open('session.resume', undefined, { session_id: 'unknown-profile', session_key: 'unknown-key', info: {} })
  expect([...session.routes.values()]).toMatchObject([
    { runtime: 'cold-runtime', stored: 'canonical-cold-key', profile: 'work' },
    { runtime: 'deferred-runtime', stored: 'canonical-deferred-key', profile: 'work' },
    { runtime: 'live-runtime', stored: 'live-key', profile: 'Work exact' },
  ])
})
