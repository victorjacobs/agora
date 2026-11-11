import { fileReference } from './hermes/media'
import { previewPath } from './markdown'

export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024
export const PREVIEW_FRAME_POLICY = "frame-src 'none'"
export type PreviewTheme = Record<string, string>

export async function loadPreview(path: string, profile: string | undefined, signal: AbortSignal, fetcher = fetch): Promise<string> {
  if (!previewPath(path)) throw new Error('Unsupported preview path.')
  const response = await fetcher(fileReference(path, profile)!.url, { signal, credentials: 'same-origin', redirect: 'error', cache: 'no-store' })
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Sign in again to load this preview.' : 'Preview unavailable. The file may have moved or expired.')
  if (Number(response.headers.get('content-length')) > MAX_PREVIEW_BYTES) {
    await response.body?.cancel()
    throw new Error('Preview exceeds the 2 MiB limit.')
  }
  if (!response.body) throw new Error('Preview returned no content.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_PREVIEW_BYTES) throw new Error('Preview exceeds the 2 MiB limit.')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}

export function previewTheme(): PreviewTheme {
  const style = getComputedStyle(document.documentElement)
  return { ...Object.fromEntries(Object.entries({ '--foreground': '--text', '--muted-foreground': '--muted', '--accent': '--primary', '--border': '--border', '--card': '--surface' })
    .map(([key, value]) => [key, style.getPropertyValue(value).trim()])), '--font-sans': style.fontFamily }
}

export function buildPreviewDocument(html: string, theme: PreviewTheme): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const element of doc.querySelectorAll('base,meta,link,iframe,frame,frameset,object,embed,form,input,button[formaction],script[src],portal')) element.remove()
  for (const element of doc.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      if (['href', 'xlink:href', 'target', 'action', 'formaction', 'ping', 'download', 'nonce'].includes(attribute.name.toLowerCase())) element.removeAttributeNode(attribute)
    }
  }
  const policy = doc.createElement('meta')
  policy.httpEquiv = 'Content-Security-Policy'
  policy.content = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; media-src 'none'; worker-src 'none'"
  const style = doc.createElement('style')
  const variables = Object.entries(theme).filter(([key, value]) => /^--[a-z-]+$/.test(key) && /^[#(),.%\w\s'"-]+$/.test(value)).map(([key, value]) => `${key}:${value}`).join(';')
  style.textContent = `:root{--foreground:#252a38;--muted-foreground:#606b80;--accent:#465ac7;--border:#dfe3ed;--card:#fff;${variables};font-family:var(--font-sans,system-ui,sans-serif);color:var(--foreground);background:var(--card);color-scheme:light dark}body{margin:16px;overflow-wrap:anywhere}img,svg,canvas{max-width:100%}*{box-sizing:border-box}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}`
  const bridge = doc.createElement('script')
  bridge.textContent = `(() => {
    addEventListener('click', event => { if (event.target.closest?.('a,area')) event.preventDefault() }, true);
    addEventListener('submit', event => event.preventDefault(), true);
    addEventListener('message', event => {
      if (event.source !== parent || event.data?.type !== 'agora-preview-theme') return;
      for (const [key,value] of Object.entries(event.data.theme || {})) {
        if (/^--[a-z-]+$/.test(key) && typeof value === 'string') document.documentElement.style.setProperty(key,value);
      }
    });
    addEventListener('DOMContentLoaded', () => {
      let previous = 0;
      const report = () => { const height = Math.ceil(document.body.getBoundingClientRect().height + 32); if (height !== previous) { previous = height; parent.postMessage({type:'agora-preview-size',height}, '*') } };
      new ResizeObserver(report).observe(document.body); report();
    });
  })();`
  doc.head.prepend(policy, style, bridge)
  return '<!doctype html>\n' + doc.documentElement.outerHTML
}