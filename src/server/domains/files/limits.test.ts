import { describe, expect, it } from 'vitest'

import {
  ACCEPT_ATTRIBUTE,
  MAX_FILE_BYTES,
  MAX_ORDER_BYTES,
  MAX_FILES_PER_ORDER,
  acceptedTypeFor,
  extensionOf,
  formatBytes,
  pageLimitFor,
  refuseIntent,
  safeLabelFor,
} from './limits'

const NO_CAPS = { maxFilesPerOrder: null, maxPagesPerOrder: null }
const EMPTY = { files: 0, bytes: 0, pages: 0 }

const intent = (filename: string, byteSize = 1024, declaredMime = 'application/pdf') => ({
  filename,
  declaredMime,
  byteSize,
})

describe('extensionOf', () => {
  it('lowercases and takes the last segment', () => {
    expect(extensionOf('Assignment Final (2).PDF')).toBe('pdf')
  })

  it('ignores directory components a browser may include', () => {
    expect(extensionOf('reports/2026/thesis.pdf')).toBe('pdf')
    expect(extensionOf('C:\\Users\\amit\\thesis.pdf')).toBe('pdf')
  })

  it('returns empty for a name with no usable extension', () => {
    expect(extensionOf('README')).toBe('')
    expect(extensionOf('.gitignore')).toBe('')
    expect(extensionOf('trailing.')).toBe('')
  })
})

describe('the allowlist', () => {
  it('accepts what a print shop prints', () => {
    for (const extension of ['pdf', 'docx', 'jpg', 'png', 'txt']) {
      expect(acceptedTypeFor(extension), extension).not.toBeNull()
    }
  })

  it('has no entry for the formats that have no business near a print queue', () => {
    // Not a blocklist — these are simply absent, which is why the assertion is on the
    // lookup and not on a list of exclusions.
    for (const extension of ['zip', 'svg', 'html', 'exe', 'js', 'iso']) {
      expect(acceptedTypeFor(extension), extension).toBeNull()
    }
  })

  it('marks only PDF as paginated', () => {
    expect(acceptedTypeFor('pdf')?.paginated).toBe(true)
    expect(acceptedTypeFor('docx')?.paginated).toBe(false)
    expect(acceptedTypeFor('jpg')?.paginated).toBe(false)
  })

  it('derives the input accept attribute from the same list', () => {
    expect(ACCEPT_ATTRIBUTE).toContain('.pdf')
    expect(ACCEPT_ATTRIBUTE).not.toContain('.zip')
  })
})

describe('refuseIntent', () => {
  it('allows an ordinary PDF', () => {
    expect(refuseIntent(intent('notes.pdf'), EMPTY, NO_CAPS)).toBeNull()
  })

  it('refuses an unsupported type and names it in the message', () => {
    const refusal = refuseIntent(intent('archive.zip'), EMPTY, NO_CAPS)
    expect(refusal?.code).toBe('unsupported_type')
    expect(refusal?.message).toContain('.zip')
  })

  it('refuses a file with no extension without saying ".undefined"', () => {
    const refusal = refuseIntent(intent('scan'), EMPTY, NO_CAPS)
    expect(refusal?.code).toBe('unsupported_type')
    expect(refusal?.message).toContain('no extension')
  })

  it('refuses an empty file', () => {
    expect(refuseIntent(intent('notes.pdf', 0), EMPTY, NO_CAPS)?.code).toBe('empty')
  })

  it('refuses a file over the per-file limit', () => {
    const refusal = refuseIntent(intent('thesis.pdf', MAX_FILE_BYTES + 1), EMPTY, NO_CAPS)
    expect(refusal?.code).toBe('too_large')
    expect(refusal?.message).toContain('200 MB')
  })

  it('accepts a file exactly on the limit', () => {
    expect(refuseIntent(intent('thesis.pdf', MAX_FILE_BYTES), EMPTY, NO_CAPS)).toBeNull()
  })

  it("applies the shop's own file cap, not just the platform one", () => {
    const caps = { maxFilesPerOrder: 2, maxPagesPerOrder: null }
    expect(refuseIntent(intent('a.pdf'), { ...EMPTY, files: 1 }, caps)).toBeNull()
    const refusal = refuseIntent(intent('c.pdf'), { ...EMPTY, files: 2 }, caps)
    expect(refusal?.code).toBe('too_many_files')
    expect(refusal?.message).toContain('up to 2 files')
  })

  it('says it in the singular when a shop takes one file', () => {
    const caps = { maxFilesPerOrder: 1, maxPagesPerOrder: null }
    expect(refuseIntent(intent('b.pdf'), { ...EMPTY, files: 1 }, caps)?.message).toBe(
      'This shop takes one file per order.',
    )
  })

  it('never lets a shop cap exceed the platform cap', () => {
    const caps = { maxFilesPerOrder: 500, maxPagesPerOrder: null }
    const refusal = refuseIntent(intent('x.pdf'), { ...EMPTY, files: MAX_FILES_PER_ORDER }, caps)
    expect(refusal?.code).toBe('too_many_files')
  })

  it('refuses when the draft total would exceed the order size cap', () => {
    const totals = { files: 1, bytes: MAX_ORDER_BYTES - 512, pages: 10 }
    expect(refuseIntent(intent('big.pdf', 1024), totals, NO_CAPS)?.code).toBe('order_too_large')
  })

  it('checks the type before the size, so a huge .zip is refused as a .zip', () => {
    expect(refuseIntent(intent('huge.zip', MAX_FILE_BYTES * 4), EMPTY, NO_CAPS)?.code).toBe(
      'unsupported_type',
    )
  })
})

describe('pageLimitFor', () => {
  it("takes the stricter of the shop's cap and the platform's", () => {
    expect(pageLimitFor({ maxFilesPerOrder: null, maxPagesPerOrder: 300 })).toBe(300)
    expect(pageLimitFor({ maxFilesPerOrder: null, maxPagesPerOrder: 99_999 })).toBe(3000)
    expect(pageLimitFor({ maxFilesPerOrder: null, maxPagesPerOrder: null })).toBe(3000)
  })
})

describe('safeLabelFor', () => {
  it('contains nothing the customer typed', () => {
    expect(safeLabelFor(2, 'pdf')).toBe('File 2.pdf')
  })

  it('still produces a label when the extension is unknown', () => {
    expect(safeLabelFor(1, '')).toBe('File 1.bin')
  })
})

describe('formatBytes', () => {
  it('reads the way a person would say it', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(1024 * 1024 * 1.5)).toBe('1.5 MB')
    expect(formatBytes(1024 * 1024 * 42)).toBe('42 MB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB')
  })
})
