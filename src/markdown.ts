import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { imageSource } from './hermes/media'

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true })
markdown.core.ruler.after('inline', 'hermes-media', state => {
  for (const block of state.tokens) {
    if (!block.children) continue
    const children = block.children
    const output = []
    const appendText = (content: string) => {
      for (const [index, line] of content.split('\n').entries()) {
        if (index) output.push(new state.Token('softbreak', 'br', 0))
        if (!line) continue
        const text = new state.Token('text', '', 0)
        text.content = line
        output.push(text)
      }
    }
    for (let index = 0; index < children.length; index++) {
      const token = children[index]!
      if (token.type !== 'text') { output.push(token); continue }
      let content = token.content
      while (children[index + 1]?.type === 'text' || children[index + 1]?.type === 'softbreak') {
        const next = children[++index]!
        content += next.type === 'softbreak' ? '\n' : next.content
      }
      let offset = 0
      for (const match of content.matchAll(/MEDIA:\s*(?:"([^"\n]+)"|'([^'\n]+)'|([^\s]+))/g)) {
        const source = (match[1] || match[2] || match[3] || '').replace(/[.,;!]$/, '')
        if (!/\.(?:png|jpe?g|gif|webp|svg|bmp|ico)(?:\?.*)?$/i.test(source) || !imageSource(source)) continue
        appendText(content.slice(offset, match.index))
        const image = new state.Token('image', 'img', 0)
        image.attrSet('src', source)
        image.content = 'Generated image'
        output.push(image)
        offset = match.index! + match[0].length
      }
      appendText(content.slice(offset))
    }
    block.children = output
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
