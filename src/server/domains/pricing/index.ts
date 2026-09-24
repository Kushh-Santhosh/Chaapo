/**
 * The pricing domain's public surface.
 *
 * `repo.ts` is deliberately absent: it imports drizzle, and re-exporting it here would
 * drag a database driver into every caller — including the dev-fixture path that exists
 * precisely so the app runs without one. `service.ts` reaches it lazily instead.
 */

export * from './model'
export {
  QUOTE_VALIDITY_MINUTES,
  LARGE_JOB_PAGE_THRESHOLD,
  computeQuote,
  totalsFor,
  isPayable,
  findPrintItem,
  findFinishingItem,
  bandFor,
  countSelectedPages,
  countSheets,
  billingQuantity,
  type PricingContext,
  type PricingSettings,
} from './engine'
export {
  quoteForShop,
  isQuoteFresh,
  chargeableTotal,
  type FileFacts,
  type FileFactsPort,
  type QuoteCommand,
  type QuoteDeps,
  type QuoteItemRequest,
} from './service'
export { MissingCatalogueError, pricingSource, usingDevCatalogue, type PricingSource } from './source'
export { DEV_CATALOGUES, findDevCatalogue } from './fixtures'
