import { describe, expect, it, vi } from 'vitest'
import { VaultApi, loginValidation } from '../src/hermes/vault'

describe('vault metadata', () => {
  it('scopes source status and local removals without session parameters', async () => {
    const request = vi.fn().mockResolvedValueOnce({ sources: [{ name: 'bw', display_name: 'Bitwarden', enabled: true, needs_unlock: true, unlocked: false, installed: true, token: 'never-retain' }] }).mockResolvedValueOnce({ removed: true })
    const api = new VaultApi({ request })
    expect(await api.sources('work')).toEqual([{ name: 'bw', display_name: 'Bitwarden', enabled: true, needs_unlock: true, unlocked: false, installed: true }])
    expect(request).toHaveBeenCalledWith('vault.sources', { profile: 'work' })
    const item = { id: 'vault_a', backend: 'local', label: 'Test', origin: 'https://example.test', identifier: 'me', identifier_type: 'username', created_at: '', has_otp: false }
    expect(await api.remove('work', item)).toBe(true)
    expect(request).toHaveBeenLastCalledWith('vault.remove', { profile: 'work', id: 'vault_a' })
    await expect(api.remove('work', { ...item, backend: 'bw' })).rejects.toThrow('read-only')
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('rejects invalid additions before sending credentials', async () => {
    const request = vi.fn()
    await expect(new VaultApi({ request }).add('work', { label: 'Test', origin: 'https://example.test/path', identifier: 'me', identifier_type: 'username', password: 'dummy' })).rejects.toThrow('origin')
    expect(request).not.toHaveBeenCalled()
  })
  it('accepts only explicit canonical origins without silently repairing them', async () => {
    const draft = { label: 'Test', origin: 'https://example.test', identifier: 'me', identifier_type: 'username', password: 'dummy' }
    expect(loginValidation(draft)).toBe('')
    for (const origin of ['https://EXAMPLE.test', 'https://example.test/', 'https://example.test:443', 'https://user:pass@example.test', 'http://example.test', ' https://example.test', 'javascript:alert(1)']) expect(loginValidation({ ...draft, origin })).not.toBe('')
    expect(loginValidation({ ...draft, origin: 'http://127.0.0.1:8080' })).toBe('')
    const request = vi.fn().mockResolvedValue({ id: 'vault_dummy' })
    await new VaultApi({ request }).add('work', draft)
    expect(request).toHaveBeenCalledWith('vault.add', { profile: 'work', kind: 'login', label: 'Test', origin: draft.origin, secret: { identifier: 'me', identifier_type: 'username', password: 'dummy' } })
  })
  it('uses profile-only reads and selects safe login metadata', async () => {
    const request = vi.fn().mockResolvedValue({ items: [{ id: 'vault_a', kind: 'login', label: 'Test', origin: 'https://example.test', backend: 'local', password: 'never-retain' }, { id: 'card', kind: 'payment' }] })
    const api = new VaultApi({ request })
    expect(await api.list('work')).toEqual([{ id: 'vault_a', label: 'Test', origin: 'https://example.test', backend: 'local', identifier: '', identifier_type: '', created_at: '', has_otp: false }])
    expect(request).toHaveBeenCalledWith('vault.list', { profile: 'work' })
  })
})
