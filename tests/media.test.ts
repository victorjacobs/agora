import { describe, expect, it, vi } from 'vitest'
import { HermesApi } from '../src/hermes/api'
import { generatedImage, imageSource, loadImage } from '../src/hermes/media'
import { markdownImages, renderMarkdown } from '../src/markdown'
import { historyMessages } from '../src/hermes/transcript'

const data = 'data:image/png;base64,aGVsbG8='

describe('inline agent images', () => {
  it('extracts Markdown and MEDIA images without treating code as images', () => {
    const text = '![A cat](https://fal.media/cat.png)\n\nMEDIA:"/home/hermes/images/a cat.png"\n\n`MEDIA:/tmp/example.png`\n\n```\n![Code](https://fal.media/code.png)\n```'
    expect(markdownImages(text)).toEqual(['https://fal.media/cat.png', '/home/hermes/images/a cat.png'])
    expect(markdownImages('![Image](sandbox:/home/hermes/images/cat.png)')).toEqual(['/home/hermes/images/cat.png'])
    expect(renderMarkdown(text)).not.toContain('<img')
    const rendered = renderMarkdown(text, { 'https://fal.media/cat.png': data, '/home/hermes/images/a cat.png': data })
    expect(rendered.match(/<img/g)).toHaveLength(2)
    expect(rendered).toContain('alt="A cat"')
    expect(rendered).not.toContain('src="https://')
  })

  it('renders spaced and multiline MEDIA references while preserving code and line breaks', () => {
    const text = 'Before\nMEDIA: /workspace/chart.png\nMEDIA:\n"/workspace/another chart.png"\nAfter\n\n`MEDIA: /tmp/code.png`\n\n```\nMEDIA:\n/tmp/fenced.png\n```'
    expect(markdownImages(text)).toEqual(['/workspace/chart.png', '/workspace/another chart.png'])
    const rendered = renderMarkdown(text, { '/workspace/chart.png': data, '/workspace/another chart.png': data })
    expect(rendered.match(/<img/g)).toHaveLength(2)
    expect(rendered).toContain('Before<br>')
    expect(rendered).toContain('After')
    expect(rendered).toContain('<code>MEDIA: /tmp/code.png</code>')
    expect(renderMarkdown('Escaped \\*literal\\*')).toContain('*literal*')
  })

  it('reads workspace images using the selected profile', async () => {
    const api = new HermesApi()
    const request = vi.spyOn(api, 'request').mockResolvedValue({ dataUrl: data })
    expect(await loadImage('/workspace/chart.png', api, 'work')).toBe(data)
    expect(request).toHaveBeenCalledWith('/api/fs/read-data-url?path=%2Fworkspace%2Fchart.png&profile=work')
  })

  it('loads local and remote images through the authenticated Hermes API', async () => {
    const api = new HermesApi()
    const request = vi.spyOn(api, 'request').mockResolvedValue({ dataUrl: data, data_url: data })
    expect(await loadImage('/home/hermes/images/a cat.png', api)).toBe(data)
    expect(request).toHaveBeenLastCalledWith('/api/fs/read-data-url?path=%2Fhome%2Fhermes%2Fimages%2Fa+cat.png')
    expect(await loadImage('https://fal.media/cat.png', api)).toBe(data)
    expect(request).toHaveBeenLastCalledWith('/api/media/proxy?url=https%3A%2F%2Ffal.media%2Fcat.png')
    expect(await loadImage(data, api)).toBe(data)
    expect(request).toHaveBeenCalledTimes(2)
    request.mockResolvedValue({ dataUrl: 'data:text/html;base64,aGVsbG8=' })
    await expect(loadImage('/home/hermes/images/cat.png', api)).rejects.toThrow('invalid image')
  })

  it('rejects unsafe image sources and keeps raw HTML inert', () => {
    for (const source of ['javascript:alert(1)', 'file:///etc/passwd', '//evil.test/a.png', 'data:text/html;base64,aGVsbG8=', 'https://user:password@evil.test/a.png']) expect(imageSource(source)).toBeUndefined()
    const rendered = renderMarkdown('<img src=x onerror=alert(1)>\n![x](https://fal.media/a.png)', { 'https://fal.media/a.png': 'https://evil.test/tracking.png' })
    expect(rendered).not.toMatch(/<img|onerror="/)
    expect(renderMarkdown('![cat](https://fal.media/a.png)', {}, ['https://fal.media/a.png'])).toContain('image unavailable')
  })

  it('preserves structured history images and previews successful image tools only', () => {
    const page = historyMessages({ session_id: 'a', pagination: { returned: 1, offset: 0, limit: 50 }, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Here it is' }, { type: 'image_url', image_url: { url: data } }] }] })
    expect(markdownImages(page[0]!.text)).toEqual([data])
    expect(generatedImage(JSON.stringify({ success: true, image: '/home/hermes/images/cat.png' }), 'image_generate')).toBe('/home/hermes/images/cat.png')
    expect(generatedImage(JSON.stringify({ success: true, image: '/container/cache/cat.png', host_image: '/home/hermes/cache/cat.png' }), 'image_generate')).toBe('/home/hermes/cache/cat.png')
    expect(generatedImage(JSON.stringify({ success: false, image: data }), 'image_generate')).toBeUndefined()
    expect(generatedImage(JSON.stringify({ success: true, image: data }), 'terminal')).toBeUndefined()
  })
})
