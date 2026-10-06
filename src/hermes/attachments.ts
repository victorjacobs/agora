import { imageSource } from './media'
export interface ImageAttachment { id: string; name: string; dataUrl: string }
export const imageAccept = 'image/png,image/jpeg,image/webp,image/gif'
export async function readAttachment(file: File): Promise<ImageAttachment> {
  if (!imageAccept.split(',').includes(file.type)) throw new Error('Choose a PNG, JPEG, WebP, or GIF image.')
  if (!file.size || file.size > 10 * 1024 * 1024) throw new Error('Images must be between 1 byte and 10 MB.')
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read image.'))
    reader.onerror = () => reject(new Error('Could not read image.'))
    reader.readAsDataURL(file)
  })
  return { id: crypto.randomUUID(), name: file.name || 'Pasted image', dataUrl }
}

export function extractImageReferences(text: string): { text: string; images: string[] } {
  const lines = text.split('\n')
  let end = lines.length
  while (end && (lines[end - 1]!.trim() === '[screenshot]' || !lines[end - 1]!.trim())) end--
  let start = end
  const images: string[] = []
  while (start) {
    const match = /^@image:(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)$/.exec(lines[start - 1]!.trim())
    if (!match) break
    const value = match[1]!
    const source = imageSource(['`', '"', "'"].includes(value[0]!) ? value.slice(1, -1) : value)
    if (!source) return { text, images: [] }
    images.unshift(source)
    start--
  }
  if (!images.length) return { text, images: [] }
  return { text: lines.slice(0, start).join('\n').trimEnd(), images: [...new Set(images)] }
}
