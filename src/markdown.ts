import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { fileReference, imageSource } from './hermes/media'

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true })
const previewMarkdown = new MarkdownIt({ html: false })
export function previewPath(path: string): boolean {
  return /^(?:\/(?!\/)|~\/).+\.html?$/i.test(path)
    && !/[\u0000-\u001f\u007f-\u009f<>"'\\%?#]/.test(path)
    && !path.split('/').some(part => part === '.' || part === '..')
}
previewMarkdown.inline.ruler.before('text', 'preview', (state, silent) => {
  if (silent || state.level || state.pos > 0 && state.src[state.pos - 1] !== '\n') return false
  const end = state.src.indexOf('\n', state.pos)
  const line = state.src.slice(state.pos, end === -1 ? state.posMax : end)
  const path = /^::preview\{file="([^"\n]+)"\}$/.exec(line)?.[1]
  if (!path || !previewPath(path)) return false
  const token = state.push('preview', '', 0)
  token.content = path
  token.meta = { line: state.src.slice(0, state.pos).split('\n').length - 1 }
  state.pos += line.length
  return true
})

type PreviewPart = { kind: 'markdown'; text: string; key: string } | { kind: 'preview'; path: string; key: string }
export function previewParts(text: string): PreviewPart[] {
  const lines = text.split('\n')
  const parts: PreviewPart[] = []
  let start = 0
  let count = 0
  const tokens = previewMarkdown.parse(text, {})
  const directives = tokens.flatMap((block, index) => {
    if (block.type !== 'inline' || !block.map || tokens[index - 1]?.type !== 'paragraph_open' || tokens[index - 1]?.level !== 0) return []
    return (block.children || []).filter(token => token.type === 'preview').map(token => ({ path: token.content, line: block.map![0] + token.meta.line }))
  })
  for (const directive of directives) {
    const { line, path } = directive
    if (lines[line]?.replace(/\r$/, '') !== `::preview{file="${path}"}`) continue
    if (count++ === 4) break
    if (line > start) parts.push({ kind: 'markdown', text: lines.slice(start, line).join('\n') + '\n', key: `text-${start}` })
    parts.push({ kind: 'preview', path, key: `preview-${line}` })
    start = line + 1
  }
  if (start < lines.length) parts.push({ kind: 'markdown', text: lines.slice(start).join('\n'), key: `text-${start}` })
  return parts
}
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
