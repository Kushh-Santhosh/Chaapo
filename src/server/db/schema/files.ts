/**
 * Files — mirrors `db/migrations/0005_files.sql`.
 *
 * A customer's print job is often the most sensitive document they own. Four rules
 * shape these tables (PRD §56, §57, FR-201…FR-215):
 *
 *   1. There is no `url` column here, and there never will be. Only object *keys*
 *      are stored; access is always a freshly minted, short-lived, single-purpose
 *      signed URL issued after an authorisation check (NFR-13).
 *   2. The file name is customer content — "Aadhaar_scan.pdf" leaks as much as the
 *      file — so it is encrypted, and `safeLabel` is what goes in logs.
 *   3. Nothing is printable until sniffed, scanned and processed.
 *   4. `expiresAt` is never null: deletion is scheduled at upload time, and
 *      `bytesDeletedAt` is the proof it happened. The row outlives the bytes.
 */

import { boolean, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core'

import { bigintCount, citext, createdAt, id, timestamps, tstz } from '../columns'
import { fileStateEnum, userRoleEnum } from './enums'
import { paperSizes } from './catalogue'
import { users } from './identity'
import { shops } from './shops'

/**
 * Resumable upload intent. The row exists before the browser holds any presigned
 * URL, so a dropped connection loses nothing (PRD §D: never lose an order because
 * of an upload failure).
 */
export const fileUploadSessions = pgTable('file_upload_sessions', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** FK added in migration 0006. Nullable: files may precede choosing a shop. */
  orderId: uuid('order_id'),
  shopId: uuid('shop_id').references(() => shops.id, { onDelete: 'set null' }),

  /** Client-declared, used only to validate and plan storage. Re-derived after upload. */
  declaredNameEncrypted: text('declared_name_encrypted').notNull(),
  declaredSizeBytes: bigintCount('declared_size_bytes').notNull(),
  declaredMime: text('declared_mime').notNull(),

  storageBucket: text('storage_bucket').notNull(),
  storageKey: text('storage_key').notNull(),
  /** Multipart state. NULL for a single-shot PUT. */
  multipartUploadId: text('multipart_upload_id'),
  partSizeBytes: integer('part_size_bytes'),
  partsTotal: integer('parts_total'),
  partsCompleted: integer('parts_completed').notNull().default(0),
  /** ETags of completed parts so a resumed upload can finalise. No content, no PII. */
  completedParts: jsonb('completed_parts')
    .$type<{ partNumber: number; etag: string }[]>()
    .notNull()
    .default([]),

  /** Presigned URL validity. Minutes, not hours (NFR-13). */
  urlExpiresAt: tstz('url_expires_at').notNull(),
  /** Hard deadline for the session; abandoned ones are swept and their parts aborted. */
  expiresAt: tstz('expires_at').notNull(),

  completedAt: tstz('completed_at'),
  abortedAt: tstz('aborted_at'),
  abortReason: text('abort_reason'),
  /** FK added after `files` exists (see migration 0005). */
  fileId: uuid('file_id'),

  clientIpHash: text('client_ip_hash'),
  ...timestamps,
})

/**
 * A customer document. `storageBucket`, `storageKey` and `ownerUserId` are immutable
 * in place — moving the object would make the deletion proof point at the wrong
 * thing.
 */
export const files = pgTable('files', {
  id: id(),
  ownerUserId: uuid('owner_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** FK added in migration 0006. */
  orderId: uuid('order_id'),
  /**
   * The one shop allowed to read this file. Checked again on every signed-URL
   * request, so a shop cannot read a file for an order it does not own (FR-212).
   */
  shopId: uuid('shop_id').references(() => shops.id, { onDelete: 'set null' }),

  state: fileStateEnum('state').notNull().default('reserved'),

  originalNameEncrypted: text('original_name_encrypted').notNull(),
  /** Non-reversible label safe for logs and support tickets: 'file-7f3a.pdf'. */
  safeLabel: text('safe_label').notNull(),
  extension: text('extension'),

  storageBucket: text('storage_bucket').notNull(),
  storageKey: text('storage_key').notNull(),
  storageRegion: text('storage_region').notNull().default('ap-south-1'),
  sseMode: text('sse_mode').$type<'aes256' | 'aws:kms' | 'none'>(),
  sseKeyId: text('sse_key_id'),

  byteSize: bigintCount('byte_size'),
  /** SHA-256 of the bytes: dedupes re-uploads and proves what was printed. */
  contentSha256: text('content_sha256'),

  declaredMime: text('declared_mime'),
  detectedMime: text('detected_mime'),
  /** Browsers guess badly, so a mismatch is recorded rather than fatal — but it blocks executables. */
  mimeMismatch: boolean('mime_mismatch').notNull().default(false),

  pageCount: integer('page_count'),
  /** Per-page sizes in points, so a mixed-size PDF can be detected and flagged. */
  pageSizes: jsonb('page_sizes').$type<{ page: number; widthPt: number; heightPt: number }[]>(),
  dominantPageSize: citext('dominant_page_size').references(() => paperSizes.code),
  hasMixedPageSizes: boolean('has_mixed_page_sizes').notNull().default(false),
  /** A 40-page PDF with 3 colour pages must not be priced as 40 colour pages (FR-308). */
  colourPageCount: integer('colour_page_count'),
  isPasswordProtected: boolean('is_password_protected').notNull().default(false),
  isCorrupt: boolean('is_corrupt').notNull().default(false),
  processingError: text('processing_error'),
  processedAt: tstz('processed_at'),

  scanState: text('scan_state')
    .$type<'pending' | 'scanning' | 'clean' | 'infected' | 'error' | 'skipped'>()
    .notNull()
    .default('pending'),
  scanVerdict: text('scan_verdict').$type<'clean' | 'infected' | 'suspicious' | 'unscannable'>(),
  scanSignature: text('scan_signature'),
  scannerName: text('scanner_name'),
  scannerVersion: text('scanner_version'),
  scannedAt: tstz('scanned_at'),
  scanAttempts: integer('scan_attempts').notNull().default(0),

  rejectedAt: tstz('rejected_at'),
  rejectionCode: text('rejection_code'),
  /** Customer-facing wording written by us, never raw scanner output. */
  rejectionMessage: text('rejection_message'),

  /** Never NULL. Deletion is scheduled at creation, not remembered later (FR-903). */
  expiresAt: tstz('expires_at').notNull(),
  retentionRule: text('retention_rule')
    .$type<
      | 'default'
      | 'unattached_draft'
      | 'order_active'
      | 'order_completed'
      | 'order_cancelled'
      | 'dispute_hold'
      | 'legal_hold'
      | 'user_erasure'
    >()
    .notNull()
    .default('default'),
  retentionExtendedAt: tstz('retention_extended_at'),
  retentionExtensionReason: text('retention_extension_reason'),

  /** Proof the object is gone from storage. The row itself is kept. */
  bytesDeletedAt: tstz('bytes_deleted_at'),
  deletionReason: text('deletion_reason'),

  /** A shop downloading one file forty times is a signal worth seeing. */
  accessCount: integer('access_count').notNull().default(0),
  lastAccessedAt: tstz('last_accessed_at'),
  firstShopAccessAt: tstz('first_shop_access_at'),

  uploadSessionId: uuid('upload_session_id').references(() => fileUploadSessions.id, {
    onDelete: 'set null',
  }),
  ...timestamps,
})

/**
 * Page thumbnails. Derived from the customer's document and therefore exactly as
 * private as it is: same bucket policy, same signed-URL path, same retention. They
 * exist so a shop can confirm it is printing the right thing without pulling a
 * 40 MB PDF onto a shop laptop (FR-210).
 */
export const filePreviews = pgTable('file_previews', {
  id: id(),
  fileId: uuid('file_id')
    .notNull()
    .references(() => files.id, { onDelete: 'cascade' }),
  pageNumber: integer('page_number').notNull(),
  storageBucket: text('storage_bucket').notNull(),
  storageKey: text('storage_key').notNull(),
  widthPx: integer('width_px').notNull(),
  heightPx: integer('height_px').notNull(),
  byteSize: bigintCount('byte_size'),
  format: text('format').$type<'webp' | 'jpeg' | 'png'>().notNull().default('webp'),
  bytesDeletedAt: tstz('bytes_deleted_at'),
  ...createdAt,
})

/**
 * Append-only. Every signed URL minted for a customer file: who asked, in what role,
 * for which purpose, and whether we allowed it. This is the answer to "who looked at
 * my document" and the input to abuse detection (FR-213, NFR-16, PRD §57.5).
 */
export const fileAccessLogs = pgTable('file_access_logs', {
  id: id(),
  fileId: uuid('file_id')
    .notNull()
    .references(() => files.id, { onDelete: 'cascade' }),
  /** Denormalised so the log survives an order purge and needs no join. */
  orderId: uuid('order_id'),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  actorRole: userRoleEnum('actor_role'),
  actorShopId: uuid('actor_shop_id').references(() => shops.id, { onDelete: 'set null' }),
  purpose: text('purpose')
    .$type<
      | 'customer_preview'
      | 'customer_download'
      | 'shop_print'
      | 'shop_preview'
      | 'admin_investigation'
      | 'malware_scan'
      | 'processing'
      | 'retention_delete'
    >()
    .notNull(),
  outcome: text('outcome').$type<'granted' | 'denied'>().notNull(),
  denialReason: text('denial_reason'),
  /** Recorded so a review can confirm we are not handing out long-lived links. */
  urlTtlSeconds: integer('url_ttl_seconds'),
  ipHash: text('ip_hash'),
  userAgentFamily: text('user_agent_family'),
  ...createdAt,
})
