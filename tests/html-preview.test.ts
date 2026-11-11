import { describe, expect, it, vi } from 'vitest'
import { buildPreviewDocument, loadPreview, MAX_PREVIEW_BYTES } from '../src/html-preview'

describe('HTML preview document', () => {
  it('puts policy before content and removes hostile metadata, frames, forms and navigation attributes', () => {
    const html = buildPreviewDocument('<base href="https://evil.invalid"><meta http-equiv="refresh" content="0;url=/api/auth/logout"><meta http-equiv="Content-Security-Policy" content="default-src *"><iframe src="/api/auth/logout"></iframe><form action="/api/auth/logout"><input></form><a href="/api/auth/logout" ping="https://evil.invalid">link</a><svg><a xlink:href="https://evil.invalid">svg</a></svg><script>document.body.dataset.chart="ready"</script>', { '--font-sans': 'Inter, "Segoe UI", sans-serif' })
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.head.firstElementChild?.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(doc.head.firstElementChild?.getAttribute('content')).toContain("connect-src 'none'")
    expect(doc.querySelectorAll('meta')).toHaveLength(1)
    expect(doc.querySelector('base,iframe,form,input,[href],[ping],[xlink\\:href]')).toBeNull()
    expect(html).toContain('document.body.dataset.chart="ready"')
    expect(html).toContain('--foreground')
    expect(html).toContain('--font-sans:Inter, "Segoe UI", sans-serif')
    expect(html).toContain('prefers-reduced-motion')
  })
  it('downloads through the authenticated profile endpoint and bounds actual bytes', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('<h1>Chart</h1>'))
    expect(await loadPreview('~/chart.html', 'work', new AbortController().signal, fetcher)).toBe('<h1>Chart</h1>')
    expect(fetcher).toHaveBeenCalledWith('/api/fs/download?path=%7E%2Fchart.html&profile=work', expect.objectContaining({ credentials: 'same-origin', redirect: 'error', cache: 'no-store' }))
    fetcher.mockResolvedValue(new Response('x'.repeat(MAX_PREVIEW_BYTES + 1)))
    await expect(loadPreview('/a.html', undefined, new AbortController().signal, fetcher)).rejects.toThrow('2 MiB')
    fetcher.mockResolvedValue(new Response('expired', { status: 401 }))
    await expect(loadPreview('/a.html', undefined, new AbortController().signal, fetcher)).rejects.toThrow('Sign in')
    expect(fetcher).toHaveBeenCalledTimes(3)
    await expect(loadPreview('https://evil.invalid/a.html', undefined, new AbortController().signal, fetcher)).rejects.toThrow('Unsupported')
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})