export interface ChatReference { id: string; profile: string }

export class LastChat {
  private key = ''
  private endpoint = ''
  private principal = ''

  scope(endpoint: string, profile: string, principal: string) {
    this.endpoint = endpoint
    this.principal = principal
    this.key = endpoint && profile && principal ? `agora.last-chat:${JSON.stringify([endpoint, profile, principal])}` : ''
  }

  forget() {
    if (this.key) { this.write(); return }
    if (!this.endpoint || !this.principal) return
    // Logout can precede launch-profile discovery; clear only this endpoint's principal.
    try {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith('agora.last-chat:')) continue
        try {
          const scope: unknown = JSON.parse(key.slice('agora.last-chat:'.length))
          if (Array.isArray(scope) && scope[0] === this.endpoint && scope[2] === this.principal) localStorage.removeItem(key)
        } catch { /* Ignore malformed recovery keys. */ }
      }
    } catch { /* Browser storage is optional. */ }
  }

  read(): ChatReference | undefined {
    if (!this.key) return
    try {
      const value: unknown = JSON.parse(localStorage.getItem(this.key) || 'null')
      if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' && value.id &&
        'profile' in value && typeof value.profile === 'string' && value.profile) return { id: value.id, profile: value.profile }
    } catch { /* Browser storage is optional. */ }
  }

  write(reference?: ChatReference) {
    if (!this.key) return
    try {
      if (reference) localStorage.setItem(this.key, JSON.stringify(reference))
      else localStorage.removeItem(this.key)
    } catch { /* Browser storage is optional. */ }
  }
}
