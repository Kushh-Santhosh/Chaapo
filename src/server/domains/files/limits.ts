/**
 * What may be uploaded, and how much of it.
 *
 * These are the platform's limits. A shop's own caps (`shops.max_pages_per_order`,
 * `max_files_per_order`) are stricter and are applied on top by the service, because a
 * single-machine shop in Swargate cannot take the same job as a four-machine bulk shop.
 *
 * The allowlist is an allowlist, never a blocklist. A print shop prints documents and
 * images; there is no reason for a `.zip`, a `.svg` (which is a script container) or an
 * `.html` to reach a print queue, so they are simply absent. Both the extension and the
 * sniffed magic number have to agree — a file called `notes.pdf` whose bytes begin `MZ`
 * is refused as a mismatch rather than sent to a shop's Windows machine.
 *
 * Kept dependency-free and pure so it can be unit-tested and reused by both the client
 * hint and the server's actual decision. The client's copy is a courtesy; this module is
 * the one that decides.
 */

import type { UploadIntent, UploadRefusal } from './model'

/** Bytes. 200 MB covers a scanned thesis at 300 dpi without covering a video. */
export const MAX_FILE_BYTES = 200 * 1024 * 1024

/** Bytes, summed across a draft. Keeps one order from filling a bucket. */
export const MAX_ORDER_BYTES = 1024 * 1024 * 1024

/**
 * The platform ceiling on files per order. Shops set lower values; this exists so a shop
 * that has set nothing still cannot receive a 400-attachment order.
 */
export const MAX_FILES_PER_ORDER = 20

/** The platform ceiling on pages. A shop's `max_pages_per_order` narrows it. */
export const MAX_PAGES_PER_ORDER = 3000

/**
 * Accepted types, keyed by extension.
 *
 * `mime` is what we record as the canonical type for the extension; `magic` lists the
 * byte prefixes that count as proof. `paginated` marks the formats where a page count is
 * a real property of the file rather than a rendering decision — only `pdf` today, which
 * is why every other format is quoted rather than auto-priced by page count.
 */
export interface AcceptedType {
  extension: string
  mime: string
  label: string
  paginated: boolean
  /** Hex byte prefixes. Empty when the format has no reliable signature. */
  magic: string[]
}

export const ACCEPTED_TYPES: readonly AcceptedType[] = [
  { extension: 'pdf', mime: 'application/pdf', label: 'PDF', paginated: true, magic: ['25504446'] },
  {
    extension: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'Word document',
    paginated: false,
    // Every OOXML file is a zip. The container is all the magic number can prove; the
    // part inside is checked by whatever renders it, not here.
    magic: ['504b0304', '504b0506', '504b0708'],
  },
  {
    extension: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    label: 'PowerPoint file',
    paginated: false,
    magic: ['504b0304', '504b0506', '504b0708'],
  },
  {
    extension: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    label: 'Excel file',
    paginated: false,
    magic: ['504b0304', '504b0506', '504b0708'],
  },
  { extension: 'doc', mime: 'application/msword', label: 'Word document', paginated: false, magic: ['d0cf11e0'] },
  {
    extension: 'ppt',
    mime: 'application/vnd.ms-powerpoint',
    label: 'PowerPoint file',
    paginated: false,
    magic: ['d0cf11e0'],
  },
  { extension: 'jpg', mime: 'image/jpeg', label: 'JPEG image', paginated: false, magic: ['ffd8ff'] },
  { extension: 'jpeg', mime: 'image/jpeg', label: 'JPEG image', paginated: false, magic: ['ffd8ff'] },
  { extension: 'png', mime: 'image/png', label: 'PNG image', paginated: false, magic: ['89504e47'] },
  { extension: 'txt', mime: 'text/plain', label: 'Text file', paginated: false, magic: [] },
]

const BY_EXTENSION = new Map(ACCEPTED_TYPES.map((type) => [type.extension, type]))

/** The `accept` attribute for a file input. Derived, so it can never drift from the list. */
export const ACCEPT_ATTRIBUTE = ACCEPTED_TYPES.map((type) => `.${type.extension}`).join(',')

/** 'Assignment Final (2).PDF' → 'pdf'. Empty string when there is no extension. */
export function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

export function acceptedTypeFor(extension: string): AcceptedType | null {
  return BY_EXTENSION.get(extension.toLowerCase()) ?? null
}

/** 1_048_576 → '1.0 MB'. For customer-facing refusal messages, so they say a real number. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

/**
 * A safe label for a file, built from nothing the customer typed.
 *
 * The counter staff need to tell two attachments apart, and `File 2 of 4` does that
 * without putting `medical-report-amit-final.pdf` into a log line, a job ticket or an
 * error message. The customer's own name is kept encrypted on the row for the one place
 * it belongs: the filename on their own download.
 */
export function safeLabelFor(position: number, extension: string): string {
  return `File ${position}.${extension || 'bin'}`
}

export interface DraftTotals {
  files: number
  bytes: number
  pages: number
}

/** A shop's own caps. `null` means the shop has not set one, so only the platform cap applies. */
export interface ShopCaps {
  maxFilesPerOrder: number | null
  maxPagesPerOrder: number | null
}

/**
 * Decide whether one more file may be declared.
 *
 * Runs before a credential is minted, so a refused upload costs no bytes and no storage
 * object. Everything checkable without the bytes is checked here; the sniff and the page
 * count happen in `inspect.ts` after they arrive.
 */
export function refuseIntent(
  intent: UploadIntent,
  totals: DraftTotals,
  caps: ShopCaps,
): UploadRefusal | null {
  const extension = extensionOf(intent.filename)
  const type = acceptedTypeFor(extension)
  if (!type) {
    return {
      code: 'unsupported_type',
      message: extension
        ? `We cannot print .${extension} files. Convert it to PDF and try again.`
        : 'That file has no extension, so we cannot tell what it is. Convert it to PDF and try again.',
    }
  }

  if (intent.byteSize <= 0) {
    return { code: 'empty', message: 'That file is empty.' }
  }

  if (intent.byteSize > MAX_FILE_BYTES) {
    return {
      code: 'too_large',
      message: `That file is ${formatBytes(intent.byteSize)}. The limit for one file is ${formatBytes(MAX_FILE_BYTES)}.`,
    }
  }

  const fileLimit = Math.min(caps.maxFilesPerOrder ?? MAX_FILES_PER_ORDER, MAX_FILES_PER_ORDER)
  if (totals.files >= fileLimit) {
    return {
      code: 'too_many_files',
      message:
        fileLimit === 1
          ? 'This shop takes one file per order.'
          : `This shop takes up to ${fileLimit} files per order. Place a second order for the rest.`,
    }
  }

  if (totals.bytes + intent.byteSize > MAX_ORDER_BYTES) {
    return {
      code: 'order_too_large',
      message: `One order can total ${formatBytes(MAX_ORDER_BYTES)}. This one is already ${formatBytes(totals.bytes)}.`,
    }
  }

  return null
}

/**
 * Whether a draft's page count has outgrown what the shop will take.
 *
 * Separate from `refuseIntent` because pages are only known after inspection: the file is
 * already stored when this becomes answerable, so the answer is a message on the draft
 * rather than a refusal to upload.
 */
export function pageLimitFor(caps: ShopCaps): number {
  return Math.min(caps.maxPagesPerOrder ?? MAX_PAGES_PER_ORDER, MAX_PAGES_PER_ORDER)
}
