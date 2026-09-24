/**
 * What the rest of the app is allowed to know about a customer's file.
 *
 * Two rules shape every type here.
 *
 * **No bytes, no URLs, no filenames.** A `DraftFile` is what a screen may render and
 * what may cross the RSC boundary: a short label the shop's counter can read aloud, a
 * size, a page count, a state. The customer's own filename is encrypted at rest and is
 * decrypted only to fill a `Content-Disposition` on a single signed download. There is
 * no field on any type in this file that holds a URL, because a URL that lives longer
 * than the request that authorised it is the failure NFR-13 exists to prevent.
 *
 * **Serialisable.** Everything is a string, number, boolean or null — sizes included, so
 * that a file list can be rendered on the server, hydrated on the client, and posted
 * back without a `bigint` in the way.
 */

import type { FileState } from '../../db/schema/enums'

export type { FileState }

/** Why a file cannot be printed. Mirrors `files.rejection_code`. */
export type FileRejectionCode =
  | 'unsupported_type'
  /** Sniffed bytes disagree with the extension — a renamed executable, or a corrupt file. */
  | 'type_mismatch'
  | 'too_large'
  | 'empty'
  | 'password_protected'
  | 'corrupt'
  | 'too_many_pages'
  | 'malware'
  /** The bytes never arrived, or arrived and did not match what was declared. */
  | 'upload_incomplete'

/**
 * One file in a customer's draft.
 *
 * `pageCount` is `null` until the file has been inspected, and `pageCountReliable` is
 * `false` when we counted but do not trust the number (a scanned PDF, an office document
 * whose pagination is the renderer's opinion). The configure screen must show a page
 * count it can defend, and the pricing engine must be able to route an untrustworthy
 * count to quote-required rather than charge from it.
 */
export interface DraftFile {
  id: string
  /** Server-generated, safe to log and to print on a job ticket. Never the customer's name. */
  safeLabel: string
  /** Lowercase, no dot. `'pdf'`, `'docx'`, `'jpg'`. */
  extension: string
  /** A plain number: 200 MB fits in a double exactly, so no `bigint` is warranted. */
  byteSize: number
  state: FileState
  pageCount: number | null
  pageCountReliable: boolean
  /** `'A4'`-style code inferred from the media box, or `null` when unknown. */
  dominantPageSize: string | null
  hasMixedPageSizes: boolean
  isPasswordProtected: boolean
  rejectionCode: FileRejectionCode | null
  /** Already customer-facing prose. Safe to render. */
  rejectionMessage: string | null
  /** ISO 8601. Shown as "kept until", never as a countdown to panic about. */
  expiresAt: string
  uploadedAt: string | null
}

/** The credential half of `beginUpload`, plus the identity the client must send back. */
export interface UploadTicket {
  fileId: string
  uploadSessionId: string
  url: string
  method: 'PUT'
  headers: Record<string, string>
  expiresAt: string
  maxBytes: number
  /**
   * True when bytes are going to a local development disk rather than real object
   * storage. The upload panel says so in words; nothing else branches on it.
   */
  developmentStorage: boolean
}

/** What a client declares before it is allowed to send anything. */
export interface UploadIntent {
  /** The customer's filename. Used for the extension and for the encrypted column. */
  filename: string
  /** The browser's guess. Advisory only — the sniffed type is what decides. */
  declaredMime: string
  byteSize: number
}

/** A refusal made before any bytes moved. */
export interface UploadRefusal {
  code: FileRejectionCode | 'too_many_files' | 'order_too_large' | 'shop_not_found'
  /** Customer-facing, specific, and actionable. */
  message: string
}
