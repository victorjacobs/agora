import { describe, expect, it } from 'vitest'
import { extractImageReferences, readAttachment } from '../src/hermes/attachments'

describe('image attachment input', () => {
  it('projects persisted image references and screenshot placeholders into images and a caption', () => {
    expect(extractImageReferences('Here is a screenshot can you read it?\n@image:/var/lib/hermes/images/upload.png\n[screenshot]')).toEqual({
      text: 'Here is a screenshot can you read it?', images: ['/var/lib/hermes/images/upload.png'],
    })
    expect(extractImageReferences('@image:`/images/my photo.png`\n@image:"/images/other.png"')).toEqual({
      text: '', images: ['/images/my photo.png', '/images/other.png'],
    })
    for (const text of ['Discuss [screenshot]', '@image:/images/photo.png\nKeep this literal', '```\n@image:/images/photo.png\n```', '@image:javascript:alert(1)\n[screenshot]']) {
      expect(extractImageReferences(text)).toEqual({ text, images: [] })
    }
  })

  it('reads supported files into previews without uploading', async () => {
    const result = await readAttachment(new File(['image bytes'], 'photo.png', { type: 'image/png' }))
    expect(result.name).toBe('photo.png')
    expect(result.dataUrl).toBe('data:image/png;base64,aW1hZ2UgYnl0ZXM=')
    expect(result.id).toBeTruthy()
  })
  it('rejects unsupported, empty, and oversized files', async () => {
    await expect(readAttachment(new File(['text'], 'file.txt', { type: 'text/plain' }))).rejects.toThrow('Choose')
    await expect(readAttachment(new File([], 'empty.png', { type: 'image/png' }))).rejects.toThrow('10 MB')
    await expect(readAttachment(new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }))).rejects.toThrow('10 MB')
  })
})
