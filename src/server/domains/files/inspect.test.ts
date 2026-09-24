import { describe, expect, it } from 'vitest'

import { classifySize, inspectFile, inspectPdf, sniff } from './inspect'

/**
 * A syntactically real, minimal PDF.
 *
 * Written by hand rather than fixture-loaded so each test can state exactly which of the
 * two page-counting signals it is exercising: the `/Type /Page` object headers, or the
 * page tree's own `/Count`.
 */
function pdf(body: string): Buffer {
  return Buffer.from(`%PDF-1.4\n${body}\ntrailer<</Root 1 0 R>>\n%%EOF\n`, 'latin1')
}

const A4_BOX = '[0 0 595.28 841.89]'
const A3_BOX = '[0 0 841.89 1190.55]'

const twoPageA4 = pdf(
  [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>endobj',
    `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox${A4_BOX}>>endobj`,
    `4 0 obj<</Type/Page/Parent 2 0 R/MediaBox${A4_BOX}>>endobj`,
  ].join('\n'),
)

describe('sniff', () => {
  it('accepts a PDF whose bytes start with %PDF', () => {
    expect(sniff(twoPageA4, 'pdf')).toEqual({ mime: 'application/pdf', matchedExtension: 'pdf' })
  })

  it('names the type it actually found when the extension lies', () => {
    const jpegBytesCalledPdf = Buffer.from('ffd8ffe000104a464946', 'hex')
    expect(sniff(jpegBytesCalledPdf, 'pdf')).toEqual({
      mime: 'image/jpeg',
      matchedExtension: 'jpg',
    })
  })

  it('reports an unknown blob as unknown rather than guessing', () => {
    expect(sniff(Buffer.from('4d5a90000300', 'hex'), 'pdf')).toEqual({
      mime: null,
      matchedExtension: null,
    })
  })

  it('accepts a text file on the strength of its bytes, since .txt has no signature', () => {
    expect(sniff(Buffer.from('Chapter one\nIt was a\tTuesday.\r\n', 'utf8'), 'txt')).toEqual({
      mime: 'text/plain',
      matchedExtension: 'txt',
    })
  })

  it('refuses to call a file with NUL bytes text', () => {
    expect(sniff(Buffer.from([0x68, 0x69, 0x00, 0x68]), 'txt').matchedExtension).toBeNull()
  })
})

describe('inspectPdf', () => {
  it('trusts a count corroborated by both signals', () => {
    const facts = inspectPdf(twoPageA4)
    expect(facts.pageCount).toBe(2)
    expect(facts.reliable).toBe(true)
    expect(facts.isEncrypted).toBe(false)
  })

  it('does not count the /Type /Pages tree node as a page', () => {
    // The guard that makes this pass is the `(?![sA-Za-z])` in the page-object regex.
    expect(inspectPdf(twoPageA4).pageCount).toBe(2)
  })

  it('uses the tree count but distrusts it when no page objects are visible', () => {
    // What a cross-reference-stream PDF looks like to a byte scan: the page objects are
    // inside a compressed object stream, so only the tree's own count survives.
    const compressed = pdf('2 0 obj<</Type/Pages/Count 7>>endobj\n5 0 obj<</Type/ObjStm>>endobj')
    const facts = inspectPdf(compressed)
    expect(facts.pageCount).toBe(7)
    expect(facts.reliable).toBe(false)
  })

  it('distrusts a scan that disagrees with the tree, and prefers the tree', () => {
    // An incremental update leaves a superseded page object behind, so the scan overcounts.
    const stale = pdf(
      [
        '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
        `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox${A4_BOX}>>endobj`,
        `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox${A4_BOX}>>endobj`,
      ].join('\n'),
    )
    const facts = inspectPdf(stale)
    expect(facts.pageCount).toBe(1)
    expect(facts.reliable).toBe(false)
  })

  it('reports no count at all rather than zero when neither signal is present', () => {
    expect(inspectPdf(pdf('1 0 obj<</Type/Catalog>>endobj')).pageCount).toBeNull()
  })

  it('detects encryption', () => {
    const encrypted = Buffer.from(
      `%PDF-1.4\n2 0 obj<</Type/Pages/Count 3>>endobj\ntrailer<</Root 1 0 R/Encrypt 9 0 R>>\n%%EOF\n`,
      'latin1',
    )
    expect(inspectPdf(encrypted).isEncrypted).toBe(true)
  })

  it('tallies media boxes by standard size', () => {
    const mixed = pdf(
      [
        '2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R 5 0 R]/Count 3>>endobj',
        `3 0 obj<</Type/Page/MediaBox${A4_BOX}>>endobj`,
        `4 0 obj<</Type/Page/MediaBox${A4_BOX}>>endobj`,
        `5 0 obj<</Type/Page/MediaBox${A3_BOX}>>endobj`,
      ].join('\n'),
    )
    expect(inspectPdf(mixed).pageSizes).toEqual([
      { code: 'A4', count: 2 },
      { code: 'A3', count: 1 },
    ])
  })
})

describe('classifySize', () => {
  it('recognises A4 in either orientation', () => {
    expect(classifySize(595.28, 841.89)).toBe('A4')
    expect(classifySize(841.89, 595.28)).toBe('A4')
  })

  it('recognises the sizes a shop actually stocks', () => {
    expect(classifySize(841.89, 1190.55)).toBe('A3')
    expect(classifySize(419.53, 595.28)).toBe('A5')
    expect(classifySize(612, 792)).toBe('LETTER')
    expect(classifySize(612, 1008)).toBe('LEGAL')
  })

  it('describes an unrecognised box in millimetres instead of forcing it into a code', () => {
    expect(classifySize(300, 900)).toBe('106×318mm')
  })
})

describe('inspectFile', () => {
  it('accepts a well-formed PDF and reports what it found', () => {
    const inspection = inspectFile(twoPageA4, 'pdf')
    expect(inspection).toMatchObject({
      detectedMime: 'application/pdf',
      mimeMismatch: false,
      pageCount: 2,
      pageCountReliable: true,
      dominantPageSize: 'A4',
      hasMixedPageSizes: false,
      isPasswordProtected: false,
      isCorrupt: false,
    })
  })

  it('flags a renamed file as a mismatch without parsing it', () => {
    const inspection = inspectFile(Buffer.from('4d5a9000030000000400', 'hex'), 'pdf')
    expect(inspection.mimeMismatch).toBe(true)
    expect(inspection.pageCount).toBeNull()
  })

  it('never trusts a page count from an encrypted PDF', () => {
    const encrypted = Buffer.from(
      [
        '%PDF-1.4',
        '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
        `3 0 obj<</Type/Page/MediaBox${A4_BOX}>>endobj`,
        'trailer<</Root 1 0 R/Encrypt 9 0 R>>',
        '%%EOF',
      ].join('\n'),
      'latin1',
    )
    const inspection = inspectFile(encrypted, 'pdf')
    expect(inspection.isPasswordProtected).toBe(true)
    expect(inspection.pageCountReliable).toBe(false)
  })

  it('treats an image as one reliable page', () => {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64)])
    expect(inspectFile(png, 'png')).toMatchObject({
      detectedMime: 'image/png',
      pageCount: 1,
      pageCountReliable: true,
    })
  })

  it('gives an office document no page count at all, so pricing cannot charge by page', () => {
    const docx = Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.alloc(64)])
    const inspection = inspectFile(docx, 'docx')
    expect(inspection.mimeMismatch).toBe(false)
    expect(inspection.pageCount).toBeNull()
    expect(inspection.pageCountReliable).toBe(false)
  })

  it('calls an empty file corrupt', () => {
    expect(inspectFile(Buffer.alloc(0), 'pdf').isCorrupt).toBe(true)
  })
})
