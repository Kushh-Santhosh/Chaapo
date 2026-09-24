/**
 * The persistence contract for files, and the one row shape both implementations return.
 *
 * Written as an interface rather than letting the service talk to drizzle directly, for
 * the same reason discovery and pricing have a source seam: the upload flow has to be
 * exercisable end to end on a machine with no Postgres, and the alternative — a mock in
 * the UI layer — would mean the flow being demonstrated is not the flow that ships.
 *
 * Nothing here is a general-purpose repository. Every method is one thing the upload
 * slice actually does, and each carries `ownerUserId` so that ownership is a parameter of
 * the query rather than something a caller is trusted to have checked. A file belongs to
 * exactly one customer; a lookup that forgets to say whose it is should not compile.
 */

import type { DraftFile, FileRejectionCode, FileState } from './model'

/** A stored file, as both implementations hold it. */
export interface FileRecord {
  id: string
  ownerUserId: string
  shopId: string | null
  orderId: string | null
  state: FileState
  safeLabel: string
  extension: string
  storageBucket: string
  storageKey: string
  byteSize: number
  contentSha256: string | null
  declaredMime: string
  detectedMime: string | null
  mimeMismatch: boolean
  pageCount: number | null
  /**
   * Not a column: derived from `pageCount`, the format and `isCorrupt` when the record is
   * built, and carried here so the service does not re-derive it in three places.
   */
  pageCountReliable: boolean
  dominantPageSize: string | null
  hasMixedPageSizes: boolean
  isPasswordProtected: boolean
  isCorrupt: boolean
  rejectionCode: FileRejectionCode | null
  rejectionMessage: string | null
  expiresAt: string
  uploadedAt: string | null
  uploadSessionId: string
}

/** What a reservation needs before any bytes exist. */
export interface ReserveInput {
  ownerUserId: string
  shopId: string
  /** Encrypted envelope, never plaintext. */
  originalNameEncrypted: string
  safeLabel: string
  extension: string
  declaredMime: string
  declaredSizeBytes: number
  storageBucket: string
  storageKey: string
  /** ISO 8601. Never null — deletion is scheduled at upload time (see `files.expiresAt`). */
  expiresAt: string
  /** ISO 8601, when the presigned credential stops working. */
  urlExpiresAt: string
}

/** What inspection establishes once the bytes have landed. */
export interface CompleteInput {
  byteSize: number
  contentSha256: string
  detectedMime: string | null
  mimeMismatch: boolean
  pageCount: number | null
  pageCountReliable: boolean
  dominantPageSize: string | null
  hasMixedPageSizes: boolean
  pageSizes: { code: string; count: number }[]
  isPasswordProtected: boolean
  isCorrupt: boolean
  processingError: string | null
}

export interface FileStore {
  /** Creates the `file_upload_sessions` row and the `reserved` `files` row together. */
  reserve(input: ReserveInput): Promise<{ fileId: string; uploadSessionId: string }>

  /**
   * Move a reserved file to `ready`, or to `rejected` when inspection refused it.
   *
   * Idempotent by state: a second call for a file that is already `ready` returns the
   * existing record rather than re-writing it, because a client that retried a network
   * timeout on the finalisation step must not end up with two outcomes.
   */
  complete(
    fileId: string,
    ownerUserId: string,
    facts: CompleteInput,
  ): Promise<FileRecord | null>

  reject(
    fileId: string,
    ownerUserId: string,
    code: FileRejectionCode,
    message: string,
  ): Promise<FileRecord | null>

  /** Files this customer has uploaded for this shop that are not yet on an order. */
  listDraft(ownerUserId: string, shopId: string): Promise<FileRecord[]>

  get(fileId: string, ownerUserId: string): Promise<FileRecord | null>

  /**
   * Forget a file the customer removed from the draft.
   *
   * Returns the storage key so the caller can delete the bytes; the row is marked
   * deleted rather than erased, because `files.bytes_deleted_at` is the proof that
   * retention happened and a vanished row proves nothing.
   */
  remove(fileId: string, ownerUserId: string): Promise<{ storageKey: string } | null>

  /** For `FileFactsPort`. Only files this customer owns are returned. */
  factsFor(fileIds: string[], ownerUserId: string): Promise<FileRecord[]>

  /** Attach a file that has been accepted into an order. */
  attachOrder(fileId: string, ownerUserId: string, orderId: string): Promise<FileRecord | null>
}

/**
 * The projection a screen is allowed to see.
 *
 * Deliberately a whitelist rather than a spread: `storageKey`, `contentSha256` and the
 * encrypted filename must not reach a client, and an explicit projection is what makes
 * adding a field a decision instead of an accident.
 */
export function draftFileOf(record: FileRecord): DraftFile {
  return {
    id: record.id,
    safeLabel: record.safeLabel,
    extension: record.extension,
    byteSize: record.byteSize,
    state: record.state,
    pageCount: record.pageCount,
    pageCountReliable: record.pageCountReliable,
    dominantPageSize: record.dominantPageSize,
    hasMixedPageSizes: record.hasMixedPageSizes,
    isPasswordProtected: record.isPasswordProtected,
    rejectionCode: record.rejectionCode,
    rejectionMessage: record.rejectionMessage,
    expiresAt: record.expiresAt,
    uploadedAt: record.uploadedAt,
  }
}
