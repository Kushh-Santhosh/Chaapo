/**
 * What the app does with a customer's file.
 *
 * Three operations, and the order between them is the whole design:
 *
 * 1. `beginUpload` decides — from the filename, the declared size and the shop's own caps
 *    — whether this file is allowed at all, and only then mints a credential and writes a
 *    `reserved` row. A refusal here costs no bytes and leaves no object.
 * 2. The browser PUTs the bytes to storage directly. This module never sees them.
 * 3. `completeUpload` asks *storage* how many bytes actually arrived, reads them back,
 *    sniffs them, counts the pages, and moves the row to `ready` or `rejected`.
 *
 * Step 3 is why the flow is shaped this way. A client can declare any size and any type;
 * what makes a file printable is what storage holds, so the size on the row comes from
 * `head()` and the type comes from the magic number. A client that skips step 3 leaves a
 * `reserved` row that never becomes part of an order and is swept at `expires_at`. There is
 * no path by which saying "done" makes a file exist.
 *
 * Inspection runs inline here rather than in a worker. That is a stated shortcut, not a
 * design: the target architecture hands this to a queue with `pdf-lib` and a malware
 * scanner, and `scan_state` stays `'pending'` on every row precisely so nothing downstream
 * can mistake an unscanned file for a scanned one.
 */

import { createHash, randomBytes } from 'node:crypto'

import { newId } from '../../../lib/ids'
import { createEncryptor, type Encryptor } from '../../core/crypto'
import { errors, type AppError } from '../../core/errors'
import { err, ok, type Result } from '../../core/result'
import { getStorage } from '../../providers/storage'

import { inspectFile } from './inspect'
import { extensionOf, refuseIntent, safeLabelFor, type DraftTotals, type ShopCaps } from './limits'
import { filesSource } from './source'
import { draftFileOf, type FileRecord, type FileStore } from './store'

import type { DraftFile, UploadIntent, UploadTicket } from './model'

/** How long a customer's uploaded file is kept before retention deletes it (FR-107). */
const DRAFT_RETENTION_HOURS = 24

/** How long the browser has to finish sending bytes. Generous: 200 MB on a phone is slow. */
const UPLOAD_URL_TTL_SECONDS = 30 * 60

/**
 * The store for this process, resolved once.
 *
 * `repo.ts` is imported lazily so the dev path never loads drizzle or `pg` — the same
 * reason `pricing/service.ts` defers `./repo`.
 */
let storePromise: Promise<FileStore> | null = null

async function getStore(): Promise<FileStore> {
  if (!storePromise) {
    storePromise =
      filesSource() === 'database'
        ? import('./repo').then((module) => module.databaseFileStore())
        : import('./dev-store').then((module) => module.devFileStore)
  }
  return storePromise
}

/** Testing seam: drops the memoised store so a test can switch sources. */
export function resetFileStoreCache(): void {
  storePromise = null
}

/**
 * The encryptor for `files.original_name_encrypted`.
 *
 * `process.env` directly rather than `getConfig()`, which validates every provider key in
 * the environment — the point of the dev path is that uploads work before any of that is
 * set. When no key is configured, a **per-process random key** is used: dev filenames stop
 * being readable after a restart, which is the correct outcome for a store whose records do
 * not survive a restart either, and it means there is no fixed fallback key that could
 * quietly end up protecting a real customer's filename.
 */
let encryptor: Encryptor | null = null

function nameEncryptor(): Encryptor {
  if (encryptor) return encryptor
  const configured = process.env.ENCRYPTION_KEY
  const key = configured ? Buffer.from(configured, 'base64') : randomBytes(32)
  encryptor = createEncryptor(key.byteLength === 32 ? key : randomBytes(32))
  return encryptor
}

export interface BeginUploadCommand {
  ownerUserId: string
  shopId: string
  intent: UploadIntent
  caps: ShopCaps
}

/**
 * Reserve a place for one file and hand back a credential to send it.
 *
 * The storage key is built from a fresh id, not from the filename: a key derived from
 * customer input would put `medical-report.pdf` into every access log, bucket listing and
 * CDN trace that ever touches it.
 */
export async function beginUpload(
  command: BeginUploadCommand,
): Promise<Result<UploadTicket, AppError>> {
  const store = await getStore()
  const existing = await store.listDraft(command.ownerUserId, command.shopId)
  const totals = totalsOf(existing)

  const refusal = refuseIntent(command.intent, totals, command.caps)
  if (refusal) {
    // `unsupportedMedia` and `payloadTooLarge` exist for exactly these two; everything
    // else here is the customer asking for more than the shop allows.
    if (refusal.code === 'unsupported_type' || refusal.code === 'type_mismatch') {
      return err(errors.unsupportedMedia(refusal.message))
    }
    if (refusal.code === 'too_large' || refusal.code === 'order_too_large') {
      return err(errors.payloadTooLarge(refusal.message))
    }
    // The refusal message is already a sentence written for the customer, so it becomes
    // both the field error and the top-level message rather than "check the highlighted
    // fields" — there is only one field, and the reason is the whole point.
    return err(errors.validation([{ path: 'file', message: refusal.message }], refusal.message))
  }

  const extension = extensionOf(command.intent.filename)
  const storage = getStorage()
  const objectId = newId()
  const key = `drafts/${command.ownerUserId}/${objectId}.${extension}`

  const presigned = await storage.presignUpload({
    key,
    contentType: command.intent.declaredMime || 'application/octet-stream',
    maxBytes: command.intent.byteSize,
    ttlSeconds: UPLOAD_URL_TTL_SECONDS,
  })

  const reserved = await store.reserve({
    ownerUserId: command.ownerUserId,
    shopId: command.shopId,
    originalNameEncrypted: nameEncryptor().encrypt(
      command.intent.filename.slice(0, 300),
      'file.original_name',
    ),
    // Position is 1-based and counted across the draft, so labels read "File 1", "File 2"
    // in the order they were added.
    safeLabel: safeLabelFor(existing.length + 1, extension),
    extension,
    declaredMime: command.intent.declaredMime,
    declaredSizeBytes: command.intent.byteSize,
    storageBucket: storage.filesBucket,
    storageKey: key,
    expiresAt: new Date(Date.now() + DRAFT_RETENTION_HOURS * 3600_000).toISOString(),
    urlExpiresAt: presigned.expiresAt,
  })

  return ok({
    fileId: reserved.fileId,
    uploadSessionId: reserved.uploadSessionId,
    url: presigned.url,
    method: presigned.method,
    headers: presigned.headers,
    expiresAt: presigned.expiresAt,
    maxBytes: presigned.maxBytes,
    developmentStorage: storage.isDevelopmentStore,
  })
}

/**
 * Establish what actually arrived, and decide whether it can be printed.
 *
 * Nothing the client says is used. If storage has no object, the file is rejected as an
 * incomplete upload — which is the honest outcome for a client that reported success it
 * did not achieve.
 */
export async function completeUpload(
  ownerUserId: string,
  fileId: string,
): Promise<Result<DraftFile, AppError>> {
  const store = await getStore()
  const record = await store.get(fileId, ownerUserId)
  if (!record) return err(errors.notFound('File'))
  if (record.state === 'ready' || record.state === 'rejected') {
    return ok(draftFileOf(record))
  }

  const storage = getStorage()
  const object = await storage.head(record.storageKey)
  if (!object || object.byteSize === 0) {
    const rejected = await store.reject(
      fileId,
      ownerUserId,
      'upload_incomplete',
      'The file did not finish uploading. Try adding it again.',
    )
    return rejected ? ok(draftFileOf(rejected)) : err(errors.notFound('File'))
  }

  const bytes = await storage.read(record.storageKey)
  const inspection = inspectFile(bytes, record.extension)

  const refusal = rejectionFor(inspection)
  if (refusal) {
    const rejected = await store.reject(fileId, ownerUserId, refusal.code, refusal.message)
    return rejected ? ok(draftFileOf(rejected)) : err(errors.notFound('File'))
  }

  const completed = await store.complete(fileId, ownerUserId, {
    byteSize: object.byteSize,
    contentSha256: sha256Of(bytes),
    detectedMime: inspection.detectedMime,
    mimeMismatch: inspection.mimeMismatch,
    pageCount: inspection.pageCount,
    pageCountReliable: inspection.pageCountReliable,
    dominantPageSize: inspection.dominantPageSize,
    hasMixedPageSizes: inspection.hasMixedPageSizes,
    pageSizes: inspection.pageSizes,
    isPasswordProtected: inspection.isPasswordProtected,
    isCorrupt: inspection.isCorrupt,
    processingError: inspection.processingError,
  })

  return completed ? ok(draftFileOf(completed)) : err(errors.notFound('File'))
}

/**
 * Turn an inspection into a refusal, or `null` to accept.
 *
 * An unreliable page count is **not** a refusal. A scanned PDF is perfectly printable; it
 * is only un-*auto-priceable*, and the pricing engine already has a route for that
 * (quote-required). Rejecting it here would turn a normal job into an error.
 */
function rejectionFor(
  inspection: ReturnType<typeof inspectFile>,
): { code: 'type_mismatch' | 'password_protected' | 'corrupt'; message: string } | null {
  if (inspection.mimeMismatch) {
    return {
      code: 'type_mismatch',
      message:
        'The contents of that file do not match its name, so we cannot print it. Re-export it and try again.',
    }
  }
  if (inspection.isPasswordProtected) {
    return {
      code: 'password_protected',
      message: 'That PDF is password-protected. Remove the password and upload it again.',
    }
  }
  if (inspection.isCorrupt) {
    return {
      code: 'corrupt',
      message: 'We could not read that file. It may be damaged — try re-exporting it.',
    }
  }
  return null
}

/**
 * Storage's own view of the content.
 *
 * Recorded on the row so a later re-read can prove the bytes are the ones that were
 * inspected — the same job an S3 ETag does, computed the same way for both providers.
 */
function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The customer's draft for one shop, as a screen may render it. */
export async function listDraft(ownerUserId: string, shopId: string): Promise<DraftFile[]> {
  const store = await getStore()
  const records = await store.listDraft(ownerUserId, shopId)
  return records.map(draftFileOf)
}

/** Totals, for the "3 files · 48 pages · 12.4 MB" line and for the next limit check. */
export function totalsOf(records: FileRecord[] | DraftFile[]): DraftTotals {
  let bytes = 0
  let pages = 0
  let files = 0
  for (const record of records) {
    if (record.state === 'rejected') continue
    files += 1
    bytes += record.byteSize
    pages += record.pageCount ?? 0
  }
  return { files, bytes, pages }
}

/**
 * Remove a file from the draft, bytes and all.
 *
 * The bytes go first and the row is marked afterwards, so a failure between the two leaves
 * a row claiming a deleted object rather than an object nobody remembers — the direction
 * that retention can still clean up.
 */
export async function removeFile(
  ownerUserId: string,
  fileId: string,
): Promise<Result<true, AppError>> {
  const store = await getStore()
  const removed = await store.remove(fileId, ownerUserId)
  if (!removed) return err(errors.notFound('File'))
  await getStorage().delete(removed.storageKey)
  return ok(true)
}

export async function attachFilesToOrder(input: {
  customerUserId: string
  shopId: string
  orderId: string
  fileIds: string[]
}): Promise<Result<void, AppError>> {
  const store = await getStore()
  const owned = await store.listDraft(input.customerUserId, input.shopId)
  const ownedIds = new Set(owned.map((file) => file.id))
  const missing = input.fileIds.filter((fileId) => !ownedIds.has(fileId))
  if (missing.length > 0) {
    return err(errors.notFound('One of those files', 'One of those files is no longer available.'))
  }

  for (const fileId of input.fileIds) {
    const attached = await store.attachOrder(fileId, input.customerUserId, input.orderId)
    if (!attached) {
      return err(errors.notFound('One of those files', 'One of those files is no longer available.'))
    }
  }

  return ok()
}

/**
 * `FileFactsPort` for the pricing engine.
 *
 * The contract that matters is the second argument: a `fileId` belonging to another
 * customer is simply absent from the returned map, so a quote request carrying someone
 * else's file fails as an unknown file rather than pricing it.
 */
export const fileFacts = {
  async factsFor(fileIds: string[], ownerCustomerId: string) {
    const store = await getStore()
    const records = await store.factsFor(fileIds, ownerCustomerId)
    return new Map(
      records.map((record) => [
        record.id,
        {
          fileId: record.id,
          pageCount: record.pageCount ?? 0,
          pageCountReliable: record.pageCountReliable,
          // Only PDFs have a page count we will charge from. Everything else is the
          // renderer's opinion, which is what `autoPriceableFormat: false` means.
          autoPriceableFormat: record.extension === 'pdf',
          safeLabel: record.safeLabel,
        },
      ]),
    )
  },
}
