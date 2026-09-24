/**
 * Pricing model — the contract between the pricing engine and everything around it.
 *
 * Four properties are load-bearing:
 *
 * 1. **Serialisable.** Money is a decimal string of paise on the way in and out, so a
 *    quote can be returned by `POST /api/v1/quotes`, handed to a client island, and
 *    stored verbatim in `orders.price_snapshot` without a mapping step.
 * 2. **The client never sends a price (FR-303).** Nothing in `QuoteRequest` carries an
 *    amount. Rates come from the shop's catalogue; page counts come from the processed
 *    file row, not from the browser.
 * 3. **Every rupee is explained.** A quote is a list of lines, each with its quantity,
 *    unit, unit price and the band that produced it. "Radical price transparency"
 *    (PRD §G.2) is a data-structure decision before it is a UI one.
 * 4. **A quote records what it was computed from.** `pricingBasis` names the exact
 *    catalogue rows and band prices used, which is what makes the price snapshot on a
 *    placed order immune to later catalogue edits (FR-306).
 */

export type ColourMode = 'bw' | 'colour'
export type Sides = 'single' | 'double'
export type ServiceKind = 'print' | 'finishing' | 'scan' | 'handling'
export type PriceUnit = 'per_page' | 'per_sheet' | 'per_copy' | 'per_order' | 'per_sqft'

// ── Request ─────────────────────────────────────────────────────────────────

/** 1-indexed and inclusive, matching how people say "pages 3 to 7". */
export interface PageRange {
  from: number
  to: number
}

export interface QuoteFinishingInput {
  /** `service_items.code` — 'finishing.spiral'. */
  code: string
  /**
   * How many. Absent means the natural quantity for the item's unit: one per copy for
   * `per_copy`, one per order for `per_order`, the sheet count for `per_sheet`.
   */
  quantity?: number
}

export interface QuoteItemInput {
  /** Stable client-side id, echoed back so a breakdown row can be matched to its card. */
  ref: string
  fileId: string
  paperSizeCode: string
  colourMode: ColourMode
  sides: Sides
  copies: number
  /**
   * Total pages in the document.
   *
   * The caller must read this from the processed `files` row — never from the browser.
   * The engine cannot tell a lie here from the truth, which is exactly why the service
   * layer, not the client, is what fills it in.
   */
  documentPages: number
  /** Absent or empty means the whole document. */
  pageRanges?: PageRange[]
  finishings?: QuoteFinishingInput[]
  /**
   * Set by the file domain when the page count could not be trusted — a scanned PDF
   * with no extractable text, or a format we do not parse. Forces the quote flow
   * rather than guessing (FR-206, §31.3).
   */
  pageCountUnreliable?: boolean
  /** The file's detected format is not auto-priceable (DOCX/PPT/XLS). */
  formatNotAutoPriceable?: boolean
  /** For the customer-facing label only. Never the customer's own filename. */
  fileLabel?: string
}

export interface QuoteRequest {
  shopId: string
  items: QuoteItemInput[]
}

// ── Catalogue input ─────────────────────────────────────────────────────────

export interface CataloguePriceBand {
  minQuantity: number
  /** `null` means "and above". */
  maxQuantity: number | null
  unitPricePaise: string
  label: string | null
}

/**
 * One row of a shop's priced catalogue: the platform `service_items` row joined to the
 * shop's `shop_service_items` row and its `price_bands`.
 *
 * Flattened on purpose. The engine should not know how many tables this came from, and
 * the dev fixtures should be able to produce it without a database.
 */
export interface CatalogueItem {
  serviceItemId: string
  code: string
  name: string
  shortName: string | null
  kind: ServiceKind
  paperSizeCode: string | null
  colourMode: ColourMode | null
  sides: Sides | null
  priceUnit: PriceUnit
  /** Empty means "any paper size". */
  appliesToPaperSizes: string[]
  minPages: number | null
  maxPages: number | null
  autoPriceable: boolean
  setupMinutes: number
  minutesPer100Units: number

  isAvailable: boolean
  /** ISO instant. Set while a shop is temporarily out of something. */
  unavailableUntil: string | null
  unavailableReason: string | null
  setupFeePaise: string
  minChargePaise: string
  minQuantity: number
  maxQuantity: number | null
  requiresQuote: boolean
  quoteAboveQuantity: number | null
  notes: string | null
  /** At least one band, ordered by `minQuantity`. No bands means the item is unpriced. */
  bands: CataloguePriceBand[]
}

export interface FinishingCompatibility {
  finishingCode: string
  paperSizeCode: string
  maxPages: number | null
}

export interface ShopCatalogue {
  shopId: string
  shopSlug: string
  minOrderPaise: string
  maxPagesPerOrder: number | null
  maxFilesPerOrder: number | null
  /** Paper sizes the shop can print at all, in display order. */
  paperSizes: string[]
  items: CatalogueItem[]
  finishingCompatibility: FinishingCompatibility[]
}

// ── Result ──────────────────────────────────────────────────────────────────

export type QuoteLineKind = 'print' | 'finishing' | 'setup' | 'min_charge' | 'rounding'

export interface QuoteLine {
  kind: QuoteLineKind
  /** `service_items.code`, or a synthetic code for setup/min-charge/rounding lines. */
  code: string
  label: string
  /** 'A4 · one side · 2 copies' — what makes the rate unambiguous. */
  qualifier: string | null
  quantity: number
  unit: PriceUnit
  unitPricePaise: string
  /** 'Bulk (200+)' when a band produced this rate. */
  bandLabel: string | null
  amountPaise: string
}

export interface QuoteItemBreakdown {
  ref: string
  fileId: string
  label: string
  /** Pages actually selected for printing, before copies. */
  pages: number
  /** Page images printed: selected pages × copies. Each printed side billed once. */
  billableSides: number
  /** Physical sheets consumed. Informational — duplex halves sheets, not pages. */
  sheets: number
  copies: number
  lines: QuoteLine[]
  /** After the item-level whole-rupee rounding. */
  totalPaise: string
}

export interface QuoteTotals {
  itemsSubtotalPaise: string
  /** What the shop's minimum order added, if anything. */
  minOrderTopUpPaise: string
  subtotalPaise: string
  /** Zero and hidden under the default shop-side-commission fee model (§61). */
  platformFeePaise: string
  /** GST on the platform fee only — shop prices are tax-inclusive. */
  taxPaise: string
  totalPaise: string
}

export type QuoteBlockReason =
  | 'unreliable_page_count'
  | 'unsupported_format'
  | 'finishing_needs_inspection'
  | 'finishing_not_offered'
  | 'large_job'
  | 'item_not_priced'
  | 'item_unavailable'
  | 'over_shop_limit'
  | 'outside_item_bounds'

/**
 * Why a job cannot be auto-priced.
 *
 * Not an error: it routes the customer to the quote flow, where the shop replies with a
 * price. Every flag carries a sentence a customer can act on, because "quote required"
 * on its own reads as a refusal.
 */
export interface QuoteBlock {
  reason: QuoteBlockReason
  /** The item it came from, or `null` for an order-level problem. */
  itemRef: string | null
  message: string
}

/** The exact catalogue row and rate used for one line, for the price snapshot. */
export interface PricingBasisEntry {
  serviceItemId: string
  code: string
  unitPricePaise: string
  bandMinQuantity: number
  bandMaxQuantity: number | null
  quantity: number
}

export interface Quote {
  shopId: string
  items: QuoteItemBreakdown[]
  totals: QuoteTotals
  /** True when the totals are not payable and the shop must quote by hand (FR-305). */
  quoteRequired: boolean
  blocks: QuoteBlock[]
  /** Sum of the shop's own setup and throughput estimates for this job. */
  estimatedMinutes: number
  computedAt: string
  /** Quotes go stale; the order endpoint re-validates against the live catalogue. */
  expiresAt: string
  pricingBasis: PricingBasisEntry[]
}
