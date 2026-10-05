import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { imageSource } from './hermes/media'

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true })
markdown.core.ruler.after('inline', 'hermes-media', state => {
  for (const block of state.tokens) {
    if (!block.children) continue
    block.children = block.children.flatMap(token => {
      if (token.type !== 'text') return [token]
      const parts = []
      let offset = 0
      for (const match of token.content.matchAll(/MEDIA:(?:"([^"\n]+)"|'([^'\n]+)'|([^\s]+))/g)) {
        const source = (match[1] || match[2] || match[3] || '').replace(/[.,;!]$/, '')
        if (!/\.(?:png|jpe?g|gif|webp|svg|bmp|ico)(?:\?.*)?$/i.test(source) || !imageSource(source)) continue
        const text = new state.Token('text', '', 0)
        text.content = token.content.slice(offset, match.index)
        const image = new state.Token('image', 'img', 0)
        image.attrSet('src', source)
        image.content = 'Generated image'
        parts.push(text, image)
        offset = match.index! + match[0].length
      }
      const tail = new state.Token('text', '', 0)
      tail.content = token.content.slice(offset)
      return parts.length ? [...parts, tail] : [token]
    })
  }
})

markdown.renderer.rules.image = (tokens, index, _options, env) => {
  const token = tokens[index]!
  const source = imageSource(token.attrGet('src') || '')
  const resolved = source && env?.images?.[source]
  const alt = markdown.utils.escapeHtml(token.content || 'Generated image')
  return resolved && imageSource(resolved)?.startsWith('data:')
    ? `<img src="${markdown.utils.escapeHtml(resolved)}" alt="${alt}" loading="lazy" decoding="async">`
    : `<span class="image-placeholder">${alt} (${!source ? 'unsupported image source' : env?.failures?.includes(source) ? 'image unavailable' : 'loading image…'})</span>`
}

export function markdownImages(text: string): string[] {
  return [...new Set(markdown.parse(text, {}).flatMap(block => (block.children || [])
    .filter(token => token.type === 'image')
    .map(token => imageSource(token.attrGet('src') || ''))
    .filter((source): source is string => Boolean(source))))]
}

export function renderMarkdown(text: string, images: Record<string, string> = {}, failures: string[] = []): string {
  return DOMPurify.sanitize(markdown.render(text, { images, failures }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'iframe'],
    FORBID_ATTR: ['style'],
  })
}
