import { describe, expect, it } from 'vitest'

import { localStorageProvider } from './local'

describe('localStorageProvider signed URLs', () => {
  it('uses same-origin relative URLs so uploads work on non-default ports', async () => {
    const upload = await localStorageProvider.presignUpload({
      key: 'drafts/test-user/file.pdf',
      contentType: 'application/pdf',
      maxBytes: 1024,
      ttlSeconds: 60,
    })

    expect(upload.url).toMatch(/^\/api\/storage\/local\//)
    expect(upload.url).not.toContain('http://localhost:3000')
    expect(upload.url).not.toContain('http://localhost:3100')
  })

  it('returns a relative download URL as well', async () => {
    const download = await localStorageProvider.presignDownload({
      key: 'drafts/test-user/file.pdf',
      ttlSeconds: 60,
    })

    expect(download.url).toMatch(/^\/api\/storage\/local\//)
  })
})
