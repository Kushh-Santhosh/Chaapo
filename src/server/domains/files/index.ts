/**
 * The files domain's public surface.
 *
 * `repo.ts` is deliberately absent for the same reason it is absent from the pricing
 * barrel: it imports drizzle, and re-exporting it here would drag a database driver into
 * the dev path that exists precisely so uploads work without one. `service.ts` reaches it
 * lazily.
 */

export * from './model'
export {
  ACCEPTED_TYPES,
  ACCEPT_ATTRIBUTE,
  MAX_FILES_PER_ORDER,
  MAX_FILE_BYTES,
  MAX_ORDER_BYTES,
  MAX_PAGES_PER_ORDER,
  acceptedTypeFor,
  extensionOf,
  formatBytes,
  pageLimitFor,
  refuseIntent,
  safeLabelFor,
  type AcceptedType,
  type DraftTotals,
  type ShopCaps,
} from './limits'
export { classifySize, inspectFile, inspectPdf, sniff, type FileInspection } from './inspect'
export {
  attachFilesToOrder,
  beginUpload,
  completeUpload,
  fileFacts,
  listDraft,
  removeFile,
  resetFileStoreCache,
  totalsOf,
  type BeginUploadCommand,
} from './service'
export { MissingFileStoreError, filesSource, usingDevFileStore, type FilesSource } from './source'
export { draftFileOf, type FileRecord } from './store'
