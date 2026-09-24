/**
 * The pricing engine (PRD §31, FR-301…309, IMPLEMENTATION_PLAN.md §9).
 *
 * Pure and deterministic: same request plus same catalogue plus same clock gives the
 * same quote, byte for byte. No database handle, no config lookup, no `Date.now()` —
 * everything it needs arrives as an argument. That is what makes it the one module in
 * the money path that can be exhaustively unit-tested.
 *
 * The formula, and the order it is applied in:
 *
 *     selectedPages  = pages named by the ranges, or the whole document
 *     billableSides  = selectedPages × copies          // each printed side billed once
 *     sheets         = double ? ceil(selectedPages / 2) × copies : billableSides
 *     printTotal     = bandPriceFor(billingQuantity) × billingQuantity
 *     finishing      = Σ unitPrice × quantity
 *     itemTotal      = roundToRupee(setupFee + printTotal + finishing, floored at minCharge)
 *     itemsSubtotal  = Σ itemTotal
 *     subtotal       = max(itemsSubtotal, shop.minOrderPaise)
 *     platformFee    = settings.customerPlatformFeePaise      // 0 and hidden by default
 *     tax            = gstOn(platformFee)                     // shop prices are inclusive
 *     total          = subtotal + platformFee + tax
 *
 * Two rules that are easy to get wrong and are therefore stated here:
 *
 *   • **Duplex halves sheets, not pages.** A 10-page document printed double-sided is
 *     still ten page images and is billed as ten `per_page` units; it consumes five
 *     sheets, and only a `per_sheet` rate is allowed to charge for five.
 *   • **Rounding happens once, at the item.** Rounding each line would let a job with
 *     many small lines drift by rupees, and rounding only the grand total would make
 *     the printed line items fail to add up.
 *
 * Shop price modifiers (`shop_price_modifiers` — rush surcharges, owner-run discounts)
 * are deliberately NOT applied yet. They are outside the MVP formula above, no surface
 * can create one, and a modifier that exists in the table but is silently ignored would
 * be worse than one that does not exist. When they land they belong here, itemised as
 * their own `QuoteLine`s, never folded into another number.
 */

import {
  addPaise,
  divCeil,
  divRoundHalfUp,
  gstOn,
  maxPaise,
  PAISE_PER_RUPEE,
  paise,
  serializePaise,
  sumPaise,
  ZERO,
  type Paise,
} from '../../../lib/money'
import type {
  CatalogueItem,
  CataloguePriceBand,
  ColourMode,
  PageRange,
  PricingBasisEntry,
  PriceUnit,
  Quote,
  QuoteBlock,
  QuoteItemBreakdown,
  QuoteItemInput,
  QuoteLine,
  QuoteRequest,
  QuoteTotals,
  ShopCatalogue,
  Sides,
} from './model'

/**
 * A job this size is not something a shop should have a robot promise a turnaround on,
 * so it goes to the quote flow (§31.3). A module constant rather than a config key
 * because adding a `platform_config` row means editing migration 0011; it moves there
 * when the admin console has a screen to edit it on.
 */
export const LARGE_JOB_PAGE_THRESHOLD = 500

/**
 * Finishings no rate card can settle, whatever a shop typed into one.
 *
 * These are the `service_items` codes seeded by migration 0011, matched on the whole
 * code. Everything else that needs a person is expressed as data instead — a finishing
 * row with `autoPriceable: false` or `requiresQuote: true` goes to the quote flow too,
 * which is how a shop that *has* priced hard binding gets to quote it instantly while a
 * shop that has not still gets asked.
 */
export const INSPECTION_FINISHINGS: readonly string[] = ['quote_custom_job']

/** Quotes are short-lived: the catalogue underneath them can change. */
export const QUOTE_VALIDITY_MINUTES = 30

/** The narrow slice of `platform_config` the engine reads. */
export interface PricingSettings {
  /** Flat customer-side fee. Zero under the default shop-side-commission model (§61). */
  customerPlatformFeePaise: Paise
  /** GST rate applied to the platform fee, in basis points. */
  platformFeeTaxRateBps: number
  /** Hard ceiling on pages in one order, from `platform_config`. */
  maxPagesPerOrder: number
  /** Hard ceiling on files in one order. */
  maxFilesPerOrder: number
}

export interface PricingContext {
  now: Date
  settings: PricingSettings
}

// ── Page arithmetic ─────────────────────────────────────────────────────────

/**
 * How many distinct pages the ranges select.
 *
 * Overlaps are counted once — someone who types "1-5, 3-8" means six pages, not
 * eleven, and billing them for eleven is the kind of quiet overcharge that loses a
 * marketplace its shops.
 */
export function countSelectedPages(documentPages: number, ranges?: PageRange[]): number {
  if (documentPages <= 0) return 0
  if (!ranges || ranges.length === 0) return documentPages

  const clamped = ranges
    .map((range) => ({
      from: Math.max(1, Math.min(range.from, range.to)),
      to: Math.min(documentPages, Math.max(range.from, range.to)),
    }))
    .filter((range) => range.from <= range.to)
    .sort((a, b) => a.from - b.from)

  let total = 0
  let cursor = 0
  for (const range of clamped) {
    const from = Math.max(range.from, cursor + 1)
    if (from > range.to) continue
    total += range.to - from + 1
    cursor = range.to
  }
  return total
}

/** Physical sheets. Duplex pairs pages within a copy, so an odd page count still costs a sheet. */
export function countSheets(selectedPages: number, sides: Sides, copies: number): number {
  if (selectedPages <= 0 || copies <= 0) return 0
  const perCopy = sides === 'double' ? Number(divCeil(BigInt(selectedPages), 2n)) : selectedPages
  return perCopy * copies
}

// ── Catalogue lookup ────────────────────────────────────────────────────────

/**
 * The print item for a given size/colour/sides combination.
 *
 * Matched on attributes rather than by composing a code string, because the code format
 * is the catalogue's business and a shop may stock an item we did not name.
 */
export function findPrintItem(
  catalogue: ShopCatalogue,
  paperSizeCode: string,
  colourMode: ColourMode,
  sides: Sides,
): CatalogueItem | null {
  const size = paperSizeCode.toLowerCase()
  const candidates = catalogue.items.filter(
    (item) =>
      item.kind === 'print' &&
      item.paperSizeCode?.toLowerCase() === size &&
      item.colourMode === colourMode,
  )
  // An exact sides match wins; otherwise a sides-agnostic row prices both.
  return (
    candidates.find((item) => item.sides === sides) ??
    candidates.find((item) => item.sides === null) ??
    null
  )
}

export function findFinishingItem(catalogue: ShopCatalogue, code: string): CatalogueItem | null {
  const wanted = code.toLowerCase()
  return (
    catalogue.items.find(
      (item) => item.kind === 'finishing' && item.code.toLowerCase() === wanted,
    ) ?? null
  )
}

/**
 * The band covering a quantity.
 *
 * A missing band is an error, never a fallback to zero: a shop that has not priced a
 * quantity has not agreed to print it (§35.3). The caller turns `null` into a
 * quote-required block rather than a free print.
 */
export function bandFor(bands: CataloguePriceBand[], quantity: number): CataloguePriceBand | null {
  for (const band of bands) {
    const aboveFloor = quantity >= band.minQuantity
    const belowCeiling = band.maxQuantity === null || quantity <= band.maxQuantity
    if (aboveFloor && belowCeiling) return band
  }
  return null
}

/** Which quantity a rate multiplies. */
export function billingQuantity(
  unit: PriceUnit,
  counts: { selectedPages: number; billableSides: number; sheets: number; copies: number },
): number {
  switch (unit) {
    case 'per_page':
      return counts.billableSides
    case 'per_sheet':
      return counts.sheets
    case 'per_copy':
      return counts.copies
    case 'per_order':
      return 1
    case 'per_sqft':
      // Large-format area pricing needs the media dimensions, which the MVP configure
      // screen does not collect. Priced by hand.
      return 0
  }
}

// ── Rounding ────────────────────────────────────────────────────────────────

/** Half up to whole rupees, applied once per item (FR-308). */
export function roundToRupee(amount: Paise): Paise {
  return divRoundHalfUp(amount, PAISE_PER_RUPEE) * PAISE_PER_RUPEE
}

// ── Labels ──────────────────────────────────────────────────────────────────

const SIDES_LABEL: Record<Sides, string> = { single: 'one side', double: 'both sides' }
const COLOUR_LABEL: Record<ColourMode, string> = { bw: 'black & white', colour: 'colour' }

function itemLabel(input: QuoteItemInput): string {
  const parts = [
    input.paperSizeCode.toUpperCase(),
    COLOUR_LABEL[input.colourMode],
    SIDES_LABEL[input.sides],
  ]
  if (input.copies > 1) parts.push(`${input.copies} copies`)
  return parts.join(' · ')
}

function qualifierFor(input: QuoteItemInput, selectedPages: number): string {
  const pages =
    selectedPages === input.documentPages
      ? `${selectedPages} ${selectedPages === 1 ? 'page' : 'pages'}`
      : `${selectedPages} of ${input.documentPages} pages`
  return input.copies > 1 ? `${pages} × ${input.copies} copies` : pages
}

// ── Per-item pricing ────────────────────────────────────────────────────────

interface ItemOutcome {
  breakdown: QuoteItemBreakdown
  blocks: QuoteBlock[]
  basis: PricingBasisEntry[]
  minutes: number
}

function block(reason: QuoteBlock['reason'], itemRef: string | null, message: string): QuoteBlock {
  return { reason, itemRef, message }
}

/** Throughput estimate from the shop's own numbers. Never a guess of ours. */
function minutesFor(item: CatalogueItem, quantity: number): number {
  return item.setupMinutes + Math.ceil((item.minutesPer100Units * quantity) / 100)
}

function isUnavailable(item: CatalogueItem, now: Date): boolean {
  if (!item.isAvailable) return true
  if (!item.unavailableUntil) return false
  return new Date(item.unavailableUntil).getTime() > now.getTime()
}

function priceItem(catalogue: ShopCatalogue, input: QuoteItemInput, now: Date): ItemOutcome {
  const blocks: QuoteBlock[] = []
  const basis: PricingBasisEntry[] = []
  const lines: QuoteLine[] = []
  let minutes = 0

  const copies = Math.max(1, Math.floor(input.copies))
  const selectedPages = countSelectedPages(input.documentPages, input.pageRanges)
  const billableSides = selectedPages * copies
  const sheets = countSheets(selectedPages, input.sides, copies)
  const counts = { selectedPages, billableSides, sheets, copies }
  const qualifier = qualifierFor({ ...input, copies }, selectedPages)

  if (input.pageCountUnreliable) {
    blocks.push(
      block(
        'unreliable_page_count',
        input.ref,
        'We could not count the pages in this file reliably, so the shop will confirm the price.',
      ),
    )
  }
  if (input.formatNotAutoPriceable) {
    blocks.push(
      block(
        'unsupported_format',
        input.ref,
        'This file type needs a person to look at it. Save it as a PDF for an instant price.',
      ),
    )
  }
  if (selectedPages > LARGE_JOB_PAGE_THRESHOLD || billableSides > LARGE_JOB_PAGE_THRESHOLD) {
    blocks.push(
      block(
        'large_job',
        input.ref,
        `Jobs over ${LARGE_JOB_PAGE_THRESHOLD} pages are quoted by the shop so they can commit to a realistic time.`,
      ),
    )
  }

  const print = findPrintItem(catalogue, input.paperSizeCode, input.colourMode, input.sides)
  if (!print) {
    blocks.push(
      block(
        'item_not_priced',
        input.ref,
        `This shop has not published a rate for ${input.paperSizeCode.toUpperCase()} ${COLOUR_LABEL[input.colourMode]}.`,
      ),
    )
  } else if (isUnavailable(print, now)) {
    blocks.push(
      block(
        'item_unavailable',
        input.ref,
        print.unavailableReason?.trim() ||
          `${print.shortName ?? print.name} is temporarily unavailable at this shop.`,
      ),
    )
  } else if (!print.autoPriceable || print.requiresQuote) {
    blocks.push(block('unsupported_format', input.ref, 'This shop prices this option by hand.'))
  } else {
    const quantity = billingQuantity(print.priceUnit, counts)
    const withinBounds =
      (print.minPages === null || selectedPages >= print.minPages) &&
      (print.maxPages === null || selectedPages <= print.maxPages)
    const overQuoteThreshold =
      print.quoteAboveQuantity !== null && quantity > print.quoteAboveQuantity
    const band = quantity > 0 ? bandFor(print.bands, quantity) : null

    if (!withinBounds) {
      blocks.push(
        block(
          'outside_item_bounds',
          input.ref,
          `This shop prints ${print.minPages ?? 1}–${print.maxPages ?? '∞'} pages per file at this size.`,
        ),
      )
    } else if (overQuoteThreshold) {
      blocks.push(block('large_job', input.ref, 'The shop quotes jobs this size by hand.'))
    } else if (!band) {
      blocks.push(
        block('item_not_priced', input.ref, 'This shop has not priced a job of this size yet.'),
      )
    } else {
      const unitPrice = paise(band.unitPricePaise)
      if (print.setupFeePaise !== '0' && paise(print.setupFeePaise) > ZERO) {
        lines.push({
          kind: 'setup',
          code: `${print.code}.setup`,
          label: 'Setup',
          qualifier: 'Charged once per file',
          quantity: 1,
          unit: 'per_order',
          unitPricePaise: print.setupFeePaise,
          bandLabel: null,
          amountPaise: print.setupFeePaise,
        })
      }
      lines.push({
        kind: 'print',
        code: print.code,
        label: print.shortName ?? print.name,
        qualifier,
        quantity,
        unit: print.priceUnit,
        unitPricePaise: band.unitPricePaise,
        bandLabel: band.label,
        amountPaise: serializePaise(unitPrice * BigInt(quantity)),
      })
      basis.push({
        serviceItemId: print.serviceItemId,
        code: print.code,
        unitPricePaise: band.unitPricePaise,
        bandMinQuantity: band.minQuantity,
        bandMaxQuantity: band.maxQuantity,
        quantity,
      })
      minutes += minutesFor(print, quantity)
    }
  }

  for (const requested of input.finishings ?? []) {
    const code = requested.code
    const bare = code.includes('.') ? (code.split('.').pop() ?? code) : code
    if (INSPECTION_FINISHINGS.includes(bare) || INSPECTION_FINISHINGS.includes(code)) {
      blocks.push(
        block(
          'finishing_needs_inspection',
          input.ref,
          'This finish is priced after the shop sees the job — they will send you a quote.',
        ),
      )
      continue
    }

    const finishing = findFinishingItem(catalogue, code)
    if (!finishing) {
      blocks.push(
        block('item_not_priced', input.ref, 'This shop has not published a rate for that finish.'),
      )
      continue
    }
    if (isUnavailable(finishing, now)) {
      blocks.push(
        block(
          'item_unavailable',
          input.ref,
          finishing.unavailableReason?.trim() ||
            `${finishing.shortName ?? finishing.name} is temporarily unavailable at this shop.`,
        ),
      )
      continue
    }
    // The data-driven half of the inspection rule. A shop that has not committed to a
    // rate for this finish — or has said it quotes it by hand — must be asked, even
    // though bands may exist on the row.
    if (!finishing.autoPriceable || finishing.requiresQuote) {
      blocks.push(
        block(
          'finishing_needs_inspection',
          input.ref,
          `${finishing.shortName ?? finishing.name} is priced by hand at this shop — they will send you a quote.`,
        ),
      )
      continue
    }

    const compatible = catalogue.finishingCompatibility.filter(
      (row) =>
        row.finishingCode.toLowerCase() === finishing.code.toLowerCase() &&
        row.paperSizeCode.toLowerCase() === input.paperSizeCode.toLowerCase(),
    )
    const sizeAllowed =
      finishing.appliesToPaperSizes.length === 0 ||
      finishing.appliesToPaperSizes.some(
        (size) => size.toLowerCase() === input.paperSizeCode.toLowerCase(),
      )
    if (compatible.length === 0 || !sizeAllowed) {
      blocks.push(
        block(
          'finishing_not_offered',
          input.ref,
          `This shop does not ${(finishing.shortName ?? finishing.name).toLowerCase()} at ${input.paperSizeCode.toUpperCase()}.`,
        ),
      )
      continue
    }

    const pageCap = compatible.reduce<number | null>((cap, row) => {
      if (row.maxPages === null) return cap
      return cap === null ? row.maxPages : Math.max(cap, row.maxPages)
    }, null)
    if (pageCap !== null && selectedPages > pageCap) {
      blocks.push(
        block(
          'outside_item_bounds',
          input.ref,
          `${finishing.shortName ?? finishing.name} at this shop takes up to ${pageCap} pages.`,
        ),
      )
      continue
    }

    const natural = billingQuantity(finishing.priceUnit, counts)
    const quantity = Math.max(
      finishing.minQuantity,
      requested.quantity !== undefined ? Math.max(0, Math.floor(requested.quantity)) : natural,
    )
    if (finishing.maxQuantity !== null && quantity > finishing.maxQuantity) {
      blocks.push(
        block(
          'outside_item_bounds',
          input.ref,
          `This shop applies ${(finishing.shortName ?? finishing.name).toLowerCase()} to at most ${finishing.maxQuantity} per file.`,
        ),
      )
      continue
    }

    const band = quantity > 0 ? bandFor(finishing.bands, quantity) : null
    if (!band) {
      blocks.push(
        block('item_not_priced', input.ref, 'This shop has not priced that finish at this size.'),
      )
      continue
    }

    lines.push({
      kind: 'finishing',
      code: finishing.code,
      label: finishing.shortName ?? finishing.name,
      qualifier: finishing.notes,
      quantity,
      unit: finishing.priceUnit,
      unitPricePaise: band.unitPricePaise,
      bandLabel: band.label,
      amountPaise: serializePaise(paise(band.unitPricePaise) * BigInt(quantity)),
    })
    basis.push({
      serviceItemId: finishing.serviceItemId,
      code: finishing.code,
      unitPricePaise: band.unitPricePaise,
      bandMinQuantity: band.minQuantity,
      bandMaxQuantity: band.maxQuantity,
      quantity,
    })
    minutes += minutesFor(finishing, quantity)
  }

  const gross = sumPaise(lines.map((line) => paise(line.amountPaise)))

  // The shop's per-item floor. A two-page job still costs what the shop said it costs.
  const minCharge = print ? paise(print.minChargePaise) : ZERO
  let total = gross
  if (lines.length > 0 && minCharge > gross) {
    lines.push({
      kind: 'min_charge',
      code: 'min_charge',
      label: 'Shop minimum for this item',
      qualifier: null,
      quantity: 1,
      unit: 'per_order',
      unitPricePaise: serializePaise(minCharge - gross),
      bandLabel: null,
      amountPaise: serializePaise(minCharge - gross),
    })
    total = minCharge
  }

  // Rounded once, here, and the adjustment is shown rather than hidden so the printed
  // lines always add up to the printed total.
  const rounded = roundToRupee(total)
  if (rounded !== total) {
    lines.push({
      kind: 'rounding',
      code: 'rounding',
      label: 'Rounding',
      qualifier: 'To the nearest rupee',
      quantity: 1,
      unit: 'per_order',
      unitPricePaise: serializePaise(rounded - total),
      bandLabel: null,
      amountPaise: serializePaise(rounded - total),
    })
  }

  return {
    breakdown: {
      ref: input.ref,
      fileId: input.fileId,
      label: itemLabel({ ...input, copies }),
      pages: selectedPages,
      billableSides,
      sheets,
      copies,
      lines,
      totalPaise: serializePaise(rounded),
    },
    blocks,
    basis,
    minutes,
  }
}

// ── The quote ───────────────────────────────────────────────────────────────

/**
 * Price a whole request.
 *
 * Always returns a `Quote`. A job that cannot be auto-priced comes back with
 * `quoteRequired: true` and the reasons — the totals are still filled in from whatever
 * *could* be priced, because a customer looking at a quote-required job should still see
 * the part we understand. The order endpoint refuses to charge a quote-required quote;
 * that check lives there, not here.
 */
export function computeQuote(
  request: QuoteRequest,
  catalogue: ShopCatalogue,
  context: PricingContext,
): Quote {
  const { now, settings } = context
  const items: QuoteItemBreakdown[] = []
  const blocks: QuoteBlock[] = []
  const pricingBasis: PricingBasisEntry[] = []
  let estimatedMinutes = 0

  for (const input of request.items) {
    const outcome = priceItem(catalogue, input, now)
    items.push(outcome.breakdown)
    blocks.push(...outcome.blocks)
    pricingBasis.push(...outcome.basis)
    estimatedMinutes += outcome.minutes
  }

  // ── Order-level caps. Both the platform's and the shop's own.
  const totalPages = items.reduce((sum, item) => sum + item.billableSides, 0)
  const shopPageCap = catalogue.maxPagesPerOrder
  const shopFileCap = catalogue.maxFilesPerOrder
  if (totalPages > settings.maxPagesPerOrder) {
    blocks.push(
      block(
        'over_shop_limit',
        null,
        `An order can carry up to ${settings.maxPagesPerOrder.toLocaleString('en-IN')} pages. Split this into two orders.`,
      ),
    )
  } else if (shopPageCap !== null && totalPages > shopPageCap) {
    blocks.push(
      block(
        'over_shop_limit',
        null,
        `This shop takes up to ${shopPageCap.toLocaleString('en-IN')} pages per order.`,
      ),
    )
  }
  if (request.items.length > settings.maxFilesPerOrder) {
    blocks.push(
      block('over_shop_limit', null, `An order can carry up to ${settings.maxFilesPerOrder} files.`),
    )
  } else if (shopFileCap !== null && request.items.length > shopFileCap) {
    blocks.push(
      block('over_shop_limit', null, `This shop takes up to ${shopFileCap} files per order.`),
    )
  }

  const totals = totalsFor(items, catalogue, settings)
  const expiresAt = new Date(now.getTime() + QUOTE_VALIDITY_MINUTES * 60_000)

  return {
    shopId: catalogue.shopId,
    items,
    totals,
    quoteRequired: blocks.length > 0,
    blocks,
    estimatedMinutes,
    computedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    pricingBasis,
  }
}

/**
 * Order totals.
 *
 * The minimum-order top-up is its own number rather than a silent bump of the subtotal,
 * so the checkout can say "this shop's minimum is ₹20" instead of showing a total that
 * does not match the items above it.
 */
export function totalsFor(
  items: QuoteItemBreakdown[],
  catalogue: ShopCatalogue,
  settings: PricingSettings,
): QuoteTotals {
  const itemsSubtotal = sumPaise(items.map((item) => paise(item.totalPaise)))
  const minOrder = paise(catalogue.minOrderPaise)
  // An empty basket is not "below the minimum" — it is empty, and must not be charged.
  const subtotal = itemsSubtotal === ZERO ? ZERO : maxPaise(itemsSubtotal, minOrder)
  const minOrderTopUp = subtotal - itemsSubtotal

  const platformFee = subtotal === ZERO ? ZERO : settings.customerPlatformFeePaise
  const tax = gstOn(platformFee, settings.platformFeeTaxRateBps)
  const total = addPaise(subtotal, platformFee, tax)

  return {
    itemsSubtotalPaise: serializePaise(itemsSubtotal),
    minOrderTopUpPaise: serializePaise(minOrderTopUp),
    subtotalPaise: serializePaise(subtotal),
    platformFeePaise: serializePaise(platformFee),
    taxPaise: serializePaise(tax),
    totalPaise: serializePaise(total),
  }
}

/** FR-308: a payable order is never ₹0. Checked at order creation, stated here. */
export function isPayable(quote: Quote): boolean {
  return !quote.quoteRequired && paise(quote.totals.totalPaise) > ZERO
}
