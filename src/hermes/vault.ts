import type { Gateway } from './gateway'

export interface LoginMeta { id: string; label: string; origin: string; backend: string; identifier: string; identifier_type: string; created_at: string; has_otp: boolean }
export interface VaultSource { name: string; display_name: string; enabled: boolean; needs_unlock: boolean; unlocked: boolean; installed: boolean }
const text = (value: unknown) => typeof value === 'string' ? value : ''
export interface LoginDraft { label: string; origin: string; identifier: string; identifier_type: string; password: string }
export const loginDraft = (): LoginDraft => ({ label: '', origin: '', identifier: '', identifier_type: 'email', password: '' })
export function loginValidation(draft: LoginDraft): string {
  if (!draft.label.trim() || !draft.identifier.trim() || !draft.password) return 'Label, identifier and password are required.'
  if (!['email', 'username', 'phone'].includes(draft.identifier_type)) return 'Choose an identifier type.'
  try {
    const url = new URL(draft.origin)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.origin !== draft.origin || url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && loopback)) throw new Error()
  } catch { return 'Enter an exact HTTPS origin (e.g. https://example.com), without a path, trailing slash or default port. HTTP is allowed only for loopback.' }
  return ''
}
export class VaultApi {
  constructor(private gateway: Pick<Gateway, 'request'>) {}
  async sources(profile?: string): Promise<VaultSource[]> {
    const result = await this.gateway.request<{ sources: Record<string, unknown>[] }>('vault.sources', { profile })
    if (!Array.isArray(result.sources)) throw new Error('Invalid vault sources')
    return result.sources.map(row => ({ name: text(row.name), display_name: text(row.display_name), enabled: row.enabled === true, needs_unlock: row.needs_unlock === true, unlocked: row.unlocked === true, installed: row.installed === true }))
  }
  async add(profile: string | undefined, draft: LoginDraft): Promise<string> {
    const error = loginValidation(draft)
    if (error) throw new Error(error)
    const result = await this.gateway.request<{ id: string }>('vault.add', { profile, kind: 'login', label: draft.label, origin: draft.origin, secret: { identifier: draft.identifier, identifier_type: draft.identifier_type, password: draft.password } })
    if (!text(result.id)) throw new Error('Invalid add result')
    return result.id
  }
  async remove(profile: string | undefined, item: LoginMeta): Promise<boolean> {
    if (item.backend !== 'local') throw new Error('External logins are read-only')
    const result = await this.gateway.request<{ removed: boolean }>('vault.remove', { profile, id: item.id })
    if (typeof result.removed !== 'boolean') throw new Error('Invalid remove result')
    return result.removed
  }
  async list(profile?: string): Promise<LoginMeta[]> {
    const result = await this.gateway.request<{ items: Record<string, unknown>[] }>('vault.list', { profile })
    if (!Array.isArray(result.items)) throw new Error('Invalid vault response')
    return result.items.filter(item => item.kind === 'login' && text(item.id) && text(item.backend)).map(item => ({ id: text(item.id), label: text(item.label), origin: text(item.origin), backend: text(item.backend), identifier: text(item.identifier), identifier_type: text(item.identifier_type), created_at: text(item.created_at), has_otp: item.has_otp === true }))
  }
}
