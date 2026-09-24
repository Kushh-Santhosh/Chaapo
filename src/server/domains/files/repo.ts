/**
 * File records in Postgres.
 *
 * Loaded lazily by `service.ts` so a laptop with no `DATABASE_URL` never pulls drizzle or
 * `pg` into the process — the same arrangement, and the same reason, as `pricing/repo.ts`.
 *
 * Four things here are deliberate:
 *
 * 1. **Ownership is in the `WHERE` clause, always.** Every read and every write is
 *    predicated on `owner_user_id`, so there is no code path that fetches a row and then
 *    remembers to check whose it is. A file id is a uuid v7 and therefore guessable in the
 *    way any timestamp-prefixed id is; the query is the authorisation.
 * 2. **`expires_at` is written at reservation time, never later.** The schema's rule is
 *    that deletion is scheduled before the bytes exist, so a crash between upload and
 *    finalisation leaves a file that still gets swept.
 * 3. **The upload session is inserted before the file row, with both ids pre-generated.**
 *    If the second insert fails, what is left behind is a session with no `completed_at`
 *    and an `expires_at` in the near future — exactly the row the abandoned-upload sweep
 *    is for. The alternative, a transaction spanning a presign, would hold a connection
 *    open for as long as the customer's upload takes.
 * 4. **Sizes are `bigint` in the driver and `number` in the domain.** 200 MB is exact in a
 *    double and a `bigint` would not survive the RSC boundary, so the conversion happens
 *    here rather than leaking into every screen.
 */

import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm'

import { getDb, type DbHandle } from '../../db/client'
import { fileUploadSessions, files } from '../../db/schema/files'
import { newId } from '../../../lib/ids'

import type { FileRejectionCode } from './model'
import type { CompleteInput, FileRecord, FileStore, ReserveInput } from './store'

/**
 * Page sizes we are willing to write to `files.dominant_page_size`.
 *
 * The column is a foreign key onto `paper_sizes.code`, so an unrecognised media box —
 * which `classifySize` reports as `'210×297mm'` — cannot be stored. It is kept in the
 * returned record for display and dropped on the way to the database, because inventing a
 * `paper_sizes` row to hold one odd PDF would corrupt the catalogue.
 */
const KNOWN_PAPER_CODES = new Set(['A4', 'A3', 'A5', 'LEGAL', 'LETTER', 'FS', 'A2', 'A1', 'A0', 'PHOTO4R'])

function persistablePageSize(code: string | null): string | null {
  if (!code) return null
  return KNOWN_PAPER_CODES.has(code.toUpperCase()) ? code.toUpperCase() : null
}

/** The columns a `FileRecord` is built from. Selected explicitly so the shape is visible. */
const RECORD_COLUMNS = {
  id: files.id,
  ownerUserId: files.ownerUserId,
  shopId: files.shopId,
  orderId: files.orderId,
  state: files.state,
  safeLabel: files.safeLabel,
  extension: files.extension,
  storageBucket: files.storageBucket,
  storageKey: files.storageKey,
  byteSize: files.byteSize,
  contentSha256: files.contentSha256,
  declaredMime: files.declaredMime,
  detectedMime: files.detectedMime,
  mimeMismatch: files.mimeMismatch,
  pageCount: files.pageCount,
  dominantPageSize: files.dominantPageSize,
  hasMixedPageSizes: files.hasMixedPageSizes,
  isPasswordProtected: files.isPasswordProtected,
  isCorrupt: files.isCorrupt,
  processingError: files.processingError,
  rejectionCode: files.rejectionCode,
  rejectionMessage: files.rejectionMessage,
  expiresAt: files.expiresAt,
  processedAt: files.processedAt,
  uploadSessionId: files.uploadSessionId,
} as const

/** The selected row, as the driver hands it back. */
interface SelectedRow {
  id: string
  ownerUserId: string
  shopId: string | null
  orderId: string | null
  state: FileRecord['state']
  safeLabel: string
  extension: string | null
  storageBucket: string
  storageKey: string
  byteSize: bigint | null
  contentSha256: string | null
  declaredMime: string | null
  detectedMime: string | null
  mimeMismatch: boolean
  pageCount: number | null
  dominantPageSize: string | null
  hasMixedPageSizes: boolean
  isPasswordProtected: boolean
  isCorrupt: boolean
  processingError: string | null
  rejectionCode: string | null
  rejectionMessage: string | null
  expiresAt: Date
  processedAt: Date | null
  uploadSessionId: string | null
}

/**
 * A row as the domain sees it.
 *
 * `pageCountReliable` is not a column. It is derived the same way every time: a count we
 * have, from a file we could parse, that is not password-protected and not corrupt. Keeping
 * the derivation here means the database path and the dev path cannot disagree about which
 * jobs are auto-priceable.
 */
function recordOf(row: SelectedRow): FileRecord {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    shopId: row.shopId,
    orderId: row.orderId,
    state: row.state,
    safeLabel: row.safeLabel,
    extension: (row.extension ?? '').toLowerCase(),
    storageBucket: row.storageBucket,
    storageKey: row.storageKey,
    byteSize: Number(row.byteSize ?? 0n),
    contentSha256: row.contentSha256,
    declaredMime: row.declaredMime ?? '',
    detectedMime: row.detectedMime,
    mimeMismatch: row.mimeMismatch,
    pageCount: row.pageCount,
    pageCountReliable:
      row.pageCount !== null &&
      row.pageCount > 0 &&
      !row.isCorrupt &&
      !row.isPasswordProtected &&
      row.processingError === null,
    dominantPageSize: row.dominantPageSize,
    hasMixedPageSizes: row.hasMixedPageSizes,
    isPasswordProtected: row.isPasswordProtected,
    isCorrupt: row.isCorrupt,
    rejectionCode: (row.rejectionCode as FileRejectionCode | null) ?? null,
    rejectionMessage: row.rejectionMessage,
    expiresAt: row.expiresAt.toISOString(),
    uploadedAt: row.processedAt?.toISOString() ?? null,
    uploadSessionId: row.uploadSessionId ?? '',
  }
}

export function databaseFileStore(db: DbHandle = getDb()): FileStore {
  return {
    async reserve(input: ReserveInput) {
      const fileId = newId()
      const uploadSessionId = newId()
      const expiresAt = new Date(input.expiresAt)

      await db.insert(fileUploadSessions).values({
        id: uploadSessionId,
        userId: input.ownerUserId,
        shopId: input.shopId,
        declaredNameEncrypted: input.originalNameEncrypted,
        declaredSizeBytes: BigInt(input.declaredSizeBytes),
        declaredMime: input.declaredMime,
        storageBucket: input.storageBucket,
        storageKey: input.storageKey,
        urlExpiresAt: new Date(input.urlExpiresAt),
        expiresAt,
        fileId,
      })

      await db.insert(files).values({
        id: fileId,
        ownerUserId: input.ownerUserId,
        shopId: input.shopId,
        state: 'reserved',
        originalNameEncrypted: input.originalNameEncrypted,
        safeLabel: input.safeLabel,
        extension: input.extension,
        storageBucket: input.storageBucket,
        storageKey: input.storageKey,
        declaredMime: input.declaredMime,
        expiresAt,
        uploadSessionId,
      })

      return { fileId, uploadSessionId }
    },

    async complete(fileId: string, ownerUserId: string, facts: CompleteInput) {
      const existing = await this.get(fileId, ownerUserId)
      if (!existing) return null
      // Idempotent finalisation: a client that retried a timed-out request gets the first
      // outcome, not a second write. Payments are not the only place that matters.
      if (existing.state === 'ready' || existing.state === 'rejected') return existing

      const now = new Date()
      await db
        .update(files)
        .set({
          state: 'ready',
          byteSize: BigInt(facts.byteSize),
          contentSha256: facts.contentSha256,
          detectedMime: facts.detectedMime,
          mimeMismatch: facts.mimeMismatch,
          pageCount: facts.pageCount,
          // Per-page media boxes are the image worker's output, not something a byte scan
          // can order correctly, so the column stays null rather than holding a guess.
          pageSizes: null,
          dominantPageSize: persistablePageSize(facts.dominantPageSize),
          hasMixedPageSizes: facts.hasMixedPageSizes,
          isPasswordProtected: facts.isPasswordProtected,
          isCorrupt: facts.isCorrupt,
          processingError: facts.processingError,
          processedAt: now,
          updatedAt: now,
        })
        .where(and(eq(files.id, fileId), eq(files.ownerUserId, ownerUserId)))

      return this.get(fileId, ownerUserId)
    },

    async reject(fileId: string, ownerUserId: string, code: FileRejectionCode, message: string) {
      const existing = await this.get(fileId, ownerUserId)
      if (!existing) return null
      if (existing.state === 'rejected') return existing

      const now = new Date()
      await db
        .update(files)
        .set({
          state: 'rejected',
          rejectionCode: code,
          rejectionMessage: message,
          rejectedAt: now,
          updatedAt: now,
        })
        .where(and(eq(files.id, fileId), eq(files.ownerUserId, ownerUserId)))

      return this.get(fileId, ownerUserId)
    },

    async listDraft(ownerUserId: string, shopId: string) {
      const rows = await db
        .select(RECORD_COLUMNS)
        .from(files)
        .where(
          and(
            eq(files.ownerUserId, ownerUserId),
            eq(files.shopId, shopId),
            // A draft is precisely "not yet attached to an order". The nullable
            // `order_id` is what makes a draft need no table of its own.
            isNull(files.orderId),
            ne(files.state, 'deleted'),
            ne(files.state, 'expired'),
          ),
        )
        .orderBy(asc(files.createdAt))

      return rows.map(recordOf)
    },

    async get(fileId: string, ownerUserId: string) {
      const rows = await db
        .select(RECORD_COLUMNS)
        .from(files)
        .where(
          and(
            eq(files.id, fileId),
            eq(files.ownerUserId, ownerUserId),
            ne(files.state, 'deleted'),
          ),
        )
        .limit(1)

      const row = rows[0]
      return row ? recordOf(row) : null
    },

    async remove(fileId: string, ownerUserId: string) {
      const existing = await this.get(fileId, ownerUserId)
      if (!existing) return null

      const now = new Date()
      await db
        .update(files)
        .set({
          state: 'deleted',
          deletionReason: 'removed_from_draft',
          bytesDeletedAt: now,
          updatedAt: now,
        })
        .where(and(eq(files.id, fileId), eq(files.ownerUserId, ownerUserId)))

      // The row survives its bytes on purpose: `bytes_deleted_at` is the evidence that
      // deletion happened, and an erased row is evidence of nothing.
      return { storageKey: existing.storageKey }
    },

    async factsFor(fileIds: string[], ownerUserId: string) {
      if (fileIds.length === 0) return []
      const rows = await db
        .select(RECORD_COLUMNS)
        .from(files)
        .where(
          and(
            inArray(files.id, fileIds),
            eq(files.ownerUserId, ownerUserId),
            eq(files.state, 'ready'),
          ),
        )

      return rows.map(recordOf)
    },

    async attachOrder(fileId: string, ownerUserId: string, orderId: string) {
      const existing = await this.get(fileId, ownerUserId)
      if (!existing) return null

      const now = new Date()
      await db
        .update(files)
        .set({
          orderId,
          updatedAt: now,
        })
        .where(and(eq(files.id, fileId), eq(files.ownerUserId, ownerUserId)))

      return this.get(fileId, ownerUserId)
    },
  }
}
