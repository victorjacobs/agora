import { HermesApi } from './api'

export function imageSource(value: string): string | undefined {
  const source = value.replace(/^sandbox:/, '')
  if (/[\u0000-\u001f<>]/.test(source)) return undefined
  if (/^data:image\/(?:png|jpeg|gif|webp|bmp|x-icon|svg\+xml);base64,[a-z\d+/=\s]+$/i.test(source)) return source
  if ((source.startsWith('/') && !source.startsWith('//')) || source.startsWith('~/')) return source
  try {
    const url = new URL(source)
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href
  } catch { /* Local media paths are handled above. */ }
  return undefined
}

export async function loadImage(source: string, api = new HermesApi()): Promise<string> {
  const normalized = imageSource(source)
  if (!normalized) throw new Error('Unsupported image source.')
  if (normalized.startsWith('data:')) return normalized
  const remote = /^https?:/.test(normalized)
  const result = await api.request<{ data_url: string }>(remote
    ? `/api/media/proxy?${api.query({ url: normalized })}`
    : `/api/media?${api.query({ path: normalized })}`)
  if (typeof result.data_url !== 'string' || !result.data_url.startsWith('data:image/') || !imageSource(result.data_url)) throw new Error('Hermes returned an invalid image.')
  return result.data_url
}

export function generatedImage(text: string, name?: string): string | undefined {
  if (name !== 'image_generate') return undefined
  try {
    const result = JSON.parse(text)
    const source = result.host_image || result.image
    return result.success === true && typeof source === 'string' ? imageSource(source) : undefined
  } catch { return undefined }
}
