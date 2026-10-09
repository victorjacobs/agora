import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { fileReference, imageSource } from './hermes/media'

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true })
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  const token = tokens[index]!
  token.attrSet('target', '_blank')
  token.attrSet('rel', 'noopener noreferrer')
  return renderer.renderToken(tokens, index, options)
}

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
    let linkDepth = 0
    for (let index = 0; index < children.length; index++) {
      const token = children[index]!
      if (token.type === 'link_open') linkDepth++
      if (token.type === 'link_close') linkDepth--
      if (token.type !== 'text' || linkDepth) { output.push(token); continue }
      let content = token.content
      while (children[index + 1]?.type === 'text' || children[index + 1]?.type === 'softbreak') {
        const next = children[++index]!
        content += next.type === 'softbreak' ? '\n' : next.content
      }
      let offset = 0
      for (const match of content.matchAll(/MEDIA:\s*(?:"([^"\n]+)"|'([^'\n]+)'|([^\s]+))/g)) {
        const source = match[1] || match[2] || (match[3] || '').replace(/[.,;!]$/, '')
        if (!imageSource(source)) continue
        const isImage = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico)(?:\?.*)?$/i.test(source)
        if (!isImage && !fileReference(source)) continue
        appendText(content.slice(offset, match.index))
        const media = new state.Token(isImage ? 'image' : 'hermes_file', isImage ? 'img' : 'span', 0)
        media.attrSet('src', source)
        media.content = 'Generated image'
        output.push(media)
        offset = match.index! + match[0].length
      }
      appendText(content.slice(offset))
    }
    block.children = output
  }
})

markdown.renderer.rules.hermes_file = (tokens, index, _options, env) => {
  const file = fileReference(tokens[index]!.attrGet('src') || '', env?.profile)
  if (!file) return ''
  const name = markdown.utils.escapeHtml(file.name)
  return `<span class="media-file"><span class="media-file-name">${name}</span><a href="${markdown.utils.escapeHtml(file.url)}" download="${name}" aria-label="Download ${name}" rel="noopener noreferrer">Download</a></span>`
}

markdown.renderer.rules.image = (tokens, index, _options, env) => {
  const token = tokens[index]!
  const source = imageSource(token.attrGet('src') || '')
  const resolved = source && env?.images?.[source]
  const alt = markdown.utils.escapeHtml(token.content || 'Generated image')
  return resolved && imageSource(resolved)?.startsWith('data:')
    ? `<img src="${markdown.utils.escapeHtml(resolved)}" alt="${alt}" role="button" tabindex="0" aria-label="Enlarge ${alt}" loading="lazy" decoding="async">`
    : `<span class="image-placeholder">${alt} (${!source ? 'unsupported image source' : env?.failures?.includes(source) ? 'image unavailable' : 'loading image…'})</span>`
}

export function markdownImages(text: string): string[] {
  return [...new Set(markdown.parse(text, {}).flatMap(block => (block.children || [])
    .filter(token => token.type === 'image')
    .map(token => imageSource(token.attrGet('src') || ''))
    .filter((source): source is string => Boolean(source))))]
}

export function renderMarkdown(text: string, images: Record<string, string> = {}, failures: string[] = [], profile?: string): string {
  return DOMPurify.sanitize(markdown.render(text, { images, failures, profile }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'iframe'],
    FORBID_ATTR: ['style'],
    ADD_ATTR: ['target'],
  })
}
