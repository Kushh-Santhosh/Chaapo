/**
 * DEVELOPMENT-ONLY file records, held in this process.
 *
 * Selected by `source.ts` only when there is no `DATABASE_URL` and the app is development
 * or test. It is a `Map`: records do not survive a restart, are not shared between the
 * dev server and the worker, and cannot be queried. That is acceptable for the one job it
 * has — letting the upload flow be driven for real before Postgres exists — and it is why
 * `source.ts` refuses to select it in anything production-like.
 *
 * The implementation is the same `FileStore` the database implementation satisfies, so
 * the flow being exercised on a laptop is the flow that runs in production, not a
 * simulation of it.
 */

import { newId } from '../../../lib/ids'

import type { CompleteInput, FileRecord, FileStore, ReserveInput } from './store'

import type { FileRejectionCode } from './model'

const RECORDS = new Map<string, FileRecord>()

/** Cleared between tests; also handy when a dev restart leaves stale keys on disk. */
export function resetDevFileStore(): void {
  RECORDS.clear()
}

export const devFileStore: FileStore = {
  async reserve(input: ReserveInput) {
    const fileId = newId()
    const uploadSessionId = newId()
    RECORDS.set(fileId, {
      id: fileId,
      ownerUserId: input.ownerUserId,
      shopId: input.shopId,
      orderId: null,
      state: 'reserved',
      safeLabel: input.safeLabel,
      extension: input.extension,
      storageBucket: input.storageBucket,
      storageKey: input.storageKey,
      // The declared size until the bytes land and `head()` says otherwise.
      byteSize: input.declaredSizeBytes,
      contentSha256: null,
      declaredMime: input.declaredMime,
      detectedMime: null,
      mimeMismatch: false,
      pageCount: null,
      pageCountReliable: false,
      dominantPageSize: null,
      hasMixedPageSizes: false,
      isPasswordProtected: false,
      isCorrupt: false,
      rejectionCode: null,
      rejectionMessage: null,
      expiresAt: input.expiresAt,
      uploadedAt: null,
      uploadSessionId,
    })
    return { fileId, uploadSessionId }
  },

  async complete(fileId: string, ownerUserId: string, facts: CompleteInput) {
    const record = owned(fileId, ownerUserId)
    if (!record) return null
    // Idempotent: a retried finalisation gets the first outcome back, not a second one.
    if (record.state === 'ready' || record.state === 'rejected') return record

    const next: FileRecord = {
      ...record,
      state: 'ready',
      byteSize: facts.byteSize,
      contentSha256: facts.contentSha256,
      detectedMime: facts.detectedMime,
      mimeMismatch: facts.mimeMismatch,
      pageCount: facts.pageCount,
      pageCountReliable: facts.pageCountReliable,
      dominantPageSize: facts.dominantPageSize,
      hasMixedPageSizes: facts.hasMixedPageSizes,
      isPasswordProtected: facts.isPasswordProtected,
      isCorrupt: facts.isCorrupt,
      uploadedAt: new Date().toISOString(),
    }
    RECORDS.set(fileId, next)
    return next
  },

  async reject(fileId: string, ownerUserId: string, code: FileRejectionCode, message: string) {
    const record = owned(fileId, ownerUserId)
    if (!record) return null
    if (record.state === 'rejected') return record

    const next: FileRecord = {
      ...record,
      state: 'rejected',
      rejectionCode: code,
      rejectionMessage: message,
    }
    RECORDS.set(fileId, next)
    return next
  },

  async listDraft(ownerUserId: string, shopId: string) {
    return [...RECORDS.values()]
      .filter(
        (record) =>
          record.ownerUserId === ownerUserId &&
          record.shopId === shopId &&
          record.orderId === null &&
          record.state !== 'deleted',
      )
      .sort((a, b) => a.safeLabel.localeCompare(b.safeLabel, 'en', { numeric: true }))
  },

  async get(fileId: string, ownerUserId: string) {
    return owned(fileId, ownerUserId)
  },

  async remove(fileId: string, ownerUserId: string) {
    const record = owned(fileId, ownerUserId)
    if (!record) return null
    RECORDS.set(fileId, { ...record, state: 'deleted' })
    return { storageKey: record.storageKey }
  },

  async factsFor(fileIds: string[], ownerUserId: string) {
    const wanted = new Set(fileIds)
    return [...RECORDS.values()].filter(
      (record) => wanted.has(record.id) && record.ownerUserId === ownerUserId,
    )
  },

  async attachOrder(fileId: string, ownerUserId: string, orderId: string) {
    const record = owned(fileId, ownerUserId)
    if (!record) return null
    const next: FileRecord = { ...record, orderId }
    RECORDS.set(fileId, next)
    return next
  },
}

/**
 * Ownership is part of the lookup, not a check afterwards.
 *
 * A file id is a uuid v7 and so is guessable in the way any timestamp-prefixed id is;
 * returning `null` for another customer's file — rather than the record plus a later
 * `if` — is what makes a forgotten check impossible here.
 */
function owned(fileId: string, ownerUserId: string): FileRecord | null {
  const record = RECORDS.get(fileId)
  if (!record) return null
  if (record.ownerUserId !== ownerUserId) return null
  if (record.state === 'deleted') return null
  return record
}
