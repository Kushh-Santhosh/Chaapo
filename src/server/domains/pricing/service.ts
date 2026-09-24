/**
 * The pricing service — the only thing outside this folder should call.
 *
 * Its job is to assemble the three inputs the pure engine needs and refuse to guess any
 * of them:
 *
 *   • the shop's catalogue, from Postgres or the dev fixtures;
 *   • the **page count of every file, read from the processed `files` row** — never from
 *     the request body, which is why `QuoteItemInput.documentPages` is filled in here
 *     rather than accepted from the client (FR-303);
 *   • the platform settings that bound an order.
 *
 * The file facts arrive through a port rather than an import of the files domain. Pricing
 * does not need to know how a file was uploaded, scanned or stored — only how many pages
 * it has and whether that number can be trusted. It also keeps the dependency arrow
 * pointing one way, so the files domain can read prices later without a cycle.
 */

import { errors } from '../../core/errors'
import { ok, err, type Result } from '../../core/result'
import { paise } from '../../../lib/money'
import { computeQuote, type PricingContext, type PricingSettings } from './engine'
import { findDevCatalogue } from './fixtures'
import { MissingCatalogueError, pricingSource } from './source'
import type { PageRange, Quote, QuoteFinishingInput, ShopCatalogue } from './model'
import type { ColourMode, Sides } from './model'

/**
 * What a customer's browser is allowed to say about an item.
 *
 * Deliberately missing: page count, page reliability, format, and any amount. Those are
 * facts about a stored file, and the service reads them itself.
 */
export interface QuoteItemRequest {
  ref: string
  fileId: string
  paperSizeCode: string
  colourMode: ColourMode
  sides: Sides
  copies: number
  pageRanges?: PageRange[]
  finishings?: QuoteFinishingInput[]
}

export interface QuoteCommand {
  /** Slug or id; `/order/new?shop=` carries a slug. */
  shop: string
  items: QuoteItemRequest[]
}

/** The facts about one uploaded file that the price depends on. */
export interface FileFacts {
  fileId: string
  pageCount: number
  /** False for a scanned PDF with no extractable text, or a format we do not parse. */
  pageCountReliable: boolean
  /** DOCX/PPT/XLS — the layout, and so the page count, is the renderer's opinion. */
  autoPriceableFormat: boolean
  /** A safe label. Never the customer's own filename. */
  safeLabel: string | null
}

/**
 * How the service learns about files. Implemented by the files domain; a test supplies a
 * map. Takes the owner so a caller cannot price someone else's file by guessing an id —
 * the authorisation lives with the files domain, which owns the access log.
 */
export interface FileFactsPort {
  factsFor(fileIds: string[], ownerCustomerId: string): Promise<Map<string, FileFacts>>
}

export interface QuoteDeps {
  /** Who is asking. Files are private; a quote may only reference their own. */
  customerId: string
  files: FileFactsPort
  settings: PricingSettings
  now?: Date
  /** Injected in tests; production resolves it from `source.ts`. */
  loadCatalogue?: (shop: string) => Promise<ShopCatalogue | null>
}

/** Guardrails on what a request may ask for, before any catalogue lookup. */
const MAX_ITEMS_PER_REQUEST = 50
const MAX_COPIES_PER_ITEM = 500
const MAX_RANGES_PER_ITEM = 50

/**
 * Resolve the catalogue for a shop.
 *
 * `repo.ts` is imported lazily so that the dev-fixture path never loads drizzle. That
 * matters in practice: it is what lets the app run, and this module's tests run, with no
 * database driver installed.
 */
async function loadCatalogueFor(shop: string): Promise<ShopCatalogue | null> {
  if (pricingSource() === 'dev-fixtures') return findDevCatalogue(shop)
  const { loadShopCatalogue } = await import('./repo')
  return loadShopCatalogue(shop)
}

function validate(command: QuoteCommand): Result<void> {
  if (command.items.length === 0) {
    return err(errors.validation([{ path: 'items', message: 'Add at least one file.' }]))
  }
  if (command.items.length > MAX_ITEMS_PER_REQUEST) {
    return err(
      errors.validation([
        { path: 'items', message: `A quote can cover at most ${MAX_ITEMS_PER_REQUEST} items.` },
      ]),
    )
  }

  const problems = command.items.flatMap((entry, index) => {
    const at = `items.${index}`
    const found: { path: string; message: string }[] = []
    if (!Number.isInteger(entry.copies) || entry.copies < 1) {
      found.push({ path: `${at}.copies`, message: 'Copies must be a whole number, at least 1.' })
    } else if (entry.copies > MAX_COPIES_PER_ITEM) {
      found.push({
        path: `${at}.copies`,
        message: `Up to ${MAX_COPIES_PER_ITEM} copies per file. Talk to the shop for more.`,
      })
    }
    if ((entry.pageRanges?.length ?? 0) > MAX_RANGES_PER_ITEM) {
      found.push({ path: `${at}.pageRanges`, message: 'Too many page ranges.' })
    }
    for (const range of entry.pageRanges ?? []) {
      if (!Number.isInteger(range.from) || !Number.isInteger(range.to) || range.from < 1) {
        found.push({ path: `${at}.pageRanges`, message: 'Page numbers must be whole and positive.' })
        break
      }
    }
    return found
  })

  // A duplicate ref would make the breakdown unmatchable to the card that produced it.
  const refs = new Set<string>()
  for (const entry of command.items) {
    if (refs.has(entry.ref)) {
      problems.push({ path: 'items', message: 'Each item needs its own ref.' })
      break
    }
    refs.add(entry.ref)
  }

  return problems.length > 0 ? err(errors.validation(problems)) : ok()
}

/**
 * Price a request.
 *
 * Returns `Err` only for things the customer or caller got wrong — an unknown shop, a
 * file that is not theirs, a malformed item. A job that simply cannot be auto-priced is
 * an `Ok` quote with `quoteRequired: true`, because it is a normal outcome of the product
 * and the customer is meant to see the part we did understand.
 */
export async function quoteForShop(
  command: QuoteCommand,
  deps: QuoteDeps,
): Promise<Result<Quote>> {
  const invalid = validate(command)
  if (invalid.ok === false) return invalid

  let catalogue: ShopCatalogue | null
  try {
    catalogue = await (deps.loadCatalogue ?? loadCatalogueFor)(command.shop)
  } catch (cause) {
    // A misconfigured environment is ours, not the customer's, and must not read as
    // "this shop does not exist".
    if (cause instanceof MissingCatalogueError) return err(errors.internal(cause.message, cause))
    throw cause
  }
  if (!catalogue) return err(errors.notFound('That shop'))

  const fileIds = [...new Set(command.items.map((entry) => entry.fileId))]
  const facts = await deps.files.factsFor(fileIds, deps.customerId)

  const missing = fileIds.filter((id) => !facts.has(id))
  if (missing.length > 0) {
    // One message for "not yours" and "not there": a distinct "not yours" would confirm
    // that a guessed file id exists.
    return err(
      errors.notFound(
        'One of those files',
        'One of those files is no longer available. Upload it again.',
      ),
    )
  }

  const notProcessed = fileIds.filter((id) => facts.get(id)!.pageCount <= 0)
  if (notProcessed.length > 0) {
    return err(
      errors.preconditionFailed(
        'We are still reading one of your files. This usually takes a few seconds.',
        { fileIds: notProcessed },
      ),
    )
  }

  const context: PricingContext = { now: deps.now ?? new Date(), settings: deps.settings }
  const quote = computeQuote(
    {
      shopId: catalogue.shopId,
      items: command.items.map((entry) => {
        const fact = facts.get(entry.fileId)!
        return {
          ref: entry.ref,
          fileId: entry.fileId,
          paperSizeCode: entry.paperSizeCode,
          colourMode: entry.colourMode,
          sides: entry.sides,
          copies: entry.copies,
          // The load-bearing line of this module: the page count is the stored one.
          documentPages: fact.pageCount,
          pageRanges: entry.pageRanges,
          finishings: entry.finishings,
          pageCountUnreliable: !fact.pageCountReliable,
          formatNotAutoPriceable: !fact.autoPriceableFormat,
          fileLabel: fact.safeLabel ?? undefined,
        }
      }),
    },
    catalogue,
    context,
  )

  return ok(quote)
}

/**
 * Whether a stored quote may still be charged.
 *
 * The order endpoint calls this before it takes money and answers `409 QUOTE_STALE` when
 * it is false. Expiry is checked against the quote's own `expiresAt` rather than
 * recomputed, so a clock skew cannot extend a quote's life.
 */
export function isQuoteFresh(quote: Quote, now: Date = new Date()): boolean {
  return new Date(quote.expiresAt).getTime() > now.getTime()
}

/** FR-308 restated where the order endpoint can reach it: never charge ₹0. */
export function chargeableTotal(quote: Quote): Result<string> {
  if (quote.quoteRequired) {
    return err(
      errors.preconditionFailed('This job needs a price from the shop before it can be paid.'),
    )
  }
  if (paise(quote.totals.totalPaise) <= 0n) {
    return err(errors.preconditionFailed('There is nothing to pay for yet.'))
  }
  return ok(quote.totals.totalPaise)
}

