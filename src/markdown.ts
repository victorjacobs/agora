import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true })
markdown.disable('image')

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(markdown.render(text), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['img', 'style', 'form', 'input', 'iframe'],
    FORBID_ATTR: ['style'],
  })
}
