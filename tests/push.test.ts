// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createECDH } from 'node:crypto'
import { validateSubscription, notificationPayload } from '../server/push.ts'
import { replayNotifications } from '../server/push-observer.ts'

export function subscription() {
  const key = createECDH('prime256v1'); key.generateKeys()
  return { endpoint: 'https://fcm.googleapis.com/fcm/send/fictional', keys: { p256dh: key.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } }
}

describe('push boundary', () => {
  it('baselines old events, deduplicates requests and never replays across gaps or epochs', () => {
    const watch = { runtime: 'r', stored: 's', profile: 'work', epoch: '', seq: 0, seen: [] as string[] }
    const replay = { epoch: 'epoch', latest_seq: 1, truncated: false, events: [{ type: 'message.complete', session_id: 'r', seq: 1, payload: { text: 'old' } }], open_requests: [] as any[] }
    expect(replayNotifications(watch, replay)).toEqual([])
    replay.events = [{ type: 'message.complete', session_id: 'r', seq: 2, payload: { text: 'new' } }]; replay.latest_seq = 2
    replay.open_requests = [{ id: 'sudo-1', method: 'sudo', params: { session_id: 'r', command: 'NEVER PREVIEW' } }]
    expect(replayNotifications(watch, replay)).toEqual([{ kind: 'reply', text: 'new' }, { kind: 'sudo', text: undefined }])
    expect(replayNotifications(watch, replay)).toEqual([])
    replay.epoch = 'restarted'; replay.latest_seq = 3
    expect(replayNotifications(watch, replay)).toEqual([])
    replay.truncated = true; replay.latest_seq = 500
    expect(replayNotifications(watch, replay)).toEqual([])
  })
  it('uses generic sensitive previews and bounded plaintext conversation links', () => {
    const sensitive = notificationPayload('s', 'work', 'private title', 'sudo', 'password hint')
    expect(JSON.stringify(sensitive)).not.toMatch(/private title|password hint/)
    const reply = notificationPayload('s /?', 'work &', 'Project', 'reply', 'MEDIA:/private/a.pdf **Done** [report](https://private.test/token)')
    expect(reply.body).toBe('Done report')
    expect(new URL(reply.url, 'https://agora.test').searchParams.get('session')).toBe('s /?')
  })

  it('accepts browser providers and rejects SSRF targets and malformed encryption keys', () => {
    const value = subscription()
    expect(validateSubscription(value)).toEqual(value)
    for (const endpoint of ['https://localhost/a', 'https://127.0.0.1/a', 'https://fcm.googleapis.com.evil.test/a', 'https://fcm.googleapis.com:444/a', 'https://name@fcm.googleapis.com/a', 'http://fcm.googleapis.com/a', 'https://fcm.googleapis.com/a#x']) {
      expect(() => validateSubscription({ ...value, endpoint })).toThrow()
    }
    expect(() => validateSubscription({ ...value, keys: { ...value.keys, p256dh: 'x' } })).toThrow()
  })
})
