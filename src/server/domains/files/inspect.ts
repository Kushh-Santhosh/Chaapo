/**
 * What we can learn about a file from its bytes, with no dependencies.
 *
 * In the target architecture this work happens in a worker with `pdf-lib` and `sharp`,
 * and the results land on the `files` row. Neither library is installed in this
 * environment, so this module does the honest subset that pure Node can do: sniff the
 * magic number, detect PDF encryption, count pages and read media boxes by scanning the
 * file's own syntax.
 *
 * The important part is not the parsing — it is that the parser **says when it does not
 * know**. A PDF written with a cross-reference stream (1.5 and later) can keep its page
 * objects inside a compressed object stream, where a byte scan cannot see them. When that
 * happens this returns `pageCountReliable: false`, and the pricing engine's
 * `FileFactsPort` contract turns an unreliable count into quote-required rather than
 * charging a customer for a number nobody verified. Guessing here would be the one
 * failure mode that costs real money.
 *
 * `detectedMime` is what decides whether a file is printable. The browser's declared type
 * and the extension are both customer-controlled and are treated as claims.
 */

import { ACCEPTED_TYPES, acceptedTypeFor, type AcceptedType } from './limits'

/** Points per inch in PDF user space. */
const PT = 72

/** Standard sizes, in points, with the tolerance a real generator drifts by. */
const PAGE_SIZES: { code: string; width: number; height: number }[] = [
  { code: 'A3', width: 841.89, height: 1190.55 },
  { code: 'A4', width: 595.28, height: 841.89 },
  { code: 'A5', width: 419.53, height: 595.28 },
  { code: 'LETTER', width: 8.5 * PT, height: 11 * PT },
  { code: 'LEGAL', width: 8.5 * PT, height: 14 * PT },
]

const SIZE_TOLERANCE_PT = 6

export interface PageSizeCount {
  code: string
  count: number
}

export interface FileInspection {
  /** The type the bytes claim to be, or `null` when no signature matched. */
  detectedMime: string | null
  /** True when the sniffed type contradicts the extension. */
  mimeMismatch: boolean
  pageCount: number | null
  pageCountReliable: boolean
  /** Highest-count page size, or `null` when unknown. */
  dominantPageSize: string | null
  hasMixedPageSizes: boolean
  pageSizes: PageSizeCount[]
  isPasswordProtected: boolean
  isCorrupt: boolean
  /** Set when inspection could not complete. Internal; never rendered verbatim. */
  processingError: string | null
}

/**
 * Match a byte prefix against the allowlist's signatures.
 *
 * Only the declared extension's signatures are consulted, plus a scan for a signature
 * belonging to *any* accepted type, so `resume.pdf` containing a JPEG is reported as a
 * mismatch with a known type rather than as an unknown blob.
 */
export function sniff(bytes: Buffer, extension: string): { mime: string | null; matchedExtension: string | null } {
  const head = bytes.subarray(0, 16).toString('hex')
  const declared = acceptedTypeFor(extension)

  const matches = (type: AcceptedType) => type.magic.some((prefix) => head.startsWith(prefix))

  if (declared && matches(declared)) return { mime: declared.mime, matchedExtension: declared.extension }

  // `txt` has no signature, so a text file is accepted on the strength of its bytes
  // being valid UTF-8 without control characters. This is checked before falling back to
  // "unknown", and only when the customer said it was text.
  if (declared && declared.extension === 'txt' && looksLikeText(bytes)) {
    return { mime: 'text/plain', matchedExtension: 'txt' }
  }

  for (const type of ACCEPTED_TYPES) {
    if (matches(type)) return { mime: type.mime, matchedExtension: type.extension }
  }
  return { mime: null, matchedExtension: null }
}

/**
 * A file is text if a sample decodes as UTF-8 and contains no NUL or stray control
 * bytes. Tabs, newlines and carriage returns are text; a 0x00 is a binary format.
 */
function looksLikeText(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 4096)
  for (const byte of sample) {
    if (byte === 0) return false
    if (byte < 0x09) return false
    if (byte > 0x0d && byte < 0x20) return false
  }
  return true
}

interface PdfFacts {
  pageCount: number | null
  reliable: boolean
  isEncrypted: boolean
  pageSizes: PageSizeCount[]
}

/**
 * Count pages and media boxes by reading the file's syntax.
 *
 * Two independent readings, because either can be blind:
 *
 * - `/Type /Page` object headers, which a byte scan sees in a classic PDF and misses
 *   entirely in one whose objects live in compressed streams;
 * - the page tree's own `/Count`, which survives compression more often but appears in
 *   other dictionaries too, so the largest value is taken as the root's.
 *
 * When both agree, the count is trusted. When only `/Count` is visible, the number is
 * used but marked unreliable, because we could not corroborate it. When neither is
 * visible the count is `null` — the caller then treats the file as unpriceable by page,
 * which is the safe direction.
 */
export function inspectPdf(bytes: Buffer): PdfFacts {
  // Latin-1 keeps one byte per character, so offsets and regex indices line up with the
  // file and a stray 0x80-0xff byte cannot swallow a following delimiter.
  const text = bytes.toString('latin1')

  const isEncrypted = /\/Encrypt[\s<[/]/.test(text)

  let byTypePage = 0
  const typePage = /\/Type\s*\/Page(?![sA-Za-z])/g
  while (typePage.exec(text) !== null) byTypePage += 1

  let byCount = 0
  const counts = /\/Count\s+(\d+)/g
  let match: RegExpExecArray | null
  while ((match = counts.exec(text)) !== null) {
    const value = Number(match[1])
    if (Number.isFinite(value) && value > byCount) byCount = value
  }

  const sizes = mediaBoxes(text)

  if (byTypePage > 0) {
    // Incremental updates can leave a superseded page object in the file, so a scan can
    // overcount. Agreement with the tree's own count is the corroboration; otherwise the
    // tree wins and the number is not trusted.
    if (byCount === 0 || byCount === byTypePage) {
      return { pageCount: byTypePage, reliable: true, isEncrypted, pageSizes: sizes }
    }
    return { pageCount: byCount, reliable: false, isEncrypted, pageSizes: sizes }
  }

  if (byCount > 0) return { pageCount: byCount, reliable: false, isEncrypted, pageSizes: sizes }
  return { pageCount: null, reliable: false, isEncrypted, pageSizes: sizes }
}

/** Media boxes, tallied by the standard size each one rounds to. */
function mediaBoxes(text: string): PageSizeCount[] {
  const tally = new Map<string, number>()
  const boxes =
    /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/g
  let match: RegExpExecArray | null
  while ((match = boxes.exec(text)) !== null) {
    const x0 = Number(match[1])
    const y0 = Number(match[2])
    const x1 = Number(match[3])
    const y1 = Number(match[4])
    if (![x0, y0, x1, y1].every(Number.isFinite)) continue
    const code = classifySize(Math.abs(x1 - x0), Math.abs(y1 - y0))
    tally.set(code, (tally.get(code) ?? 0) + 1)
  }
  return [...tally.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
}

/**
 * Nearest standard size, in either orientation.
 *
 * Orientation is folded away on purpose: a landscape A4 page is still charged as A4, and
 * a shop that stocks A4 can print it. Anything unrecognised is reported by its size in
 * millimetres so the configure screen can say what it actually saw.
 */
export function classifySize(widthPt: number, heightPt: number): string {
  const short = Math.min(widthPt, heightPt)
  const long = Math.max(widthPt, heightPt)
  for (const size of PAGE_SIZES) {
    if (
      Math.abs(short - size.width) <= SIZE_TOLERANCE_PT &&
      Math.abs(long - size.height) <= SIZE_TOLERANCE_PT
    ) {
      return size.code
    }
  }
  const mm = (points: number) => Math.round((points / PT) * 25.4)
  return `${mm(short)}×${mm(long)}mm`
}

/**
 * Everything we can establish about one uploaded file.
 *
 * `extension` is the declared one; disagreement between it and the bytes is reported,
 * not resolved, because the decision to reject belongs to the service.
 */
export function inspectFile(bytes: Buffer, extension: string): FileInspection {
  const base: FileInspection = {
    detectedMime: null,
    mimeMismatch: false,
    pageCount: null,
    pageCountReliable: false,
    dominantPageSize: null,
    hasMixedPageSizes: false,
    pageSizes: [],
    isPasswordProtected: false,
    isCorrupt: false,
    processingError: null,
  }

  if (bytes.byteLength === 0) {
    return { ...base, isCorrupt: true, processingError: 'empty file' }
  }

  const declared = acceptedTypeFor(extension)
  const sniffed = sniff(bytes, extension)
  const mismatch = sniffed.matchedExtension === null || sniffed.mime !== declared?.mime

  if (declared?.extension !== 'pdf') {
    // Non-PDF formats have no page count we are willing to defend. A JPEG is one sheet
    // and the engine knows that; an office document's pagination belongs to whatever
    // renders it, so the count stays null and pricing routes it to quote-required.
    return {
      ...base,
      detectedMime: sniffed.mime,
      mimeMismatch: mismatch,
      pageCount: declared && ['jpg', 'jpeg', 'png'].includes(declared.extension) ? 1 : null,
      pageCountReliable: Boolean(declared && ['jpg', 'jpeg', 'png'].includes(declared.extension)),
    }
  }

  if (mismatch) {
    // Not a PDF whatever it is called: parsing it as one would be reading a hostile file
    // for no benefit, since it is going to be rejected.
    return { ...base, detectedMime: sniffed.mime, mimeMismatch: true }
  }

  const pdf = inspectPdf(bytes)
  const dominant = pdf.pageSizes[0]?.code ?? null

  return {
    detectedMime: 'application/pdf',
    mimeMismatch: false,
    pageCount: pdf.pageCount,
    // An encrypted PDF's page tree may be readable while its content is not. Printing it
    // would fail at the shop, so it is never treated as a trustworthy count.
    pageCountReliable: pdf.reliable && !pdf.isEncrypted,
    dominantPageSize: dominant,
    hasMixedPageSizes: pdf.pageSizes.length > 1,
    pageSizes: pdf.pageSizes,
    isPasswordProtected: pdf.isEncrypted,
    isCorrupt: pdf.pageCount === null && pdf.pageSizes.length === 0,
    processingError:
      pdf.pageCount === null ? 'page count not visible to the byte-level parser' : null,
  }
}
