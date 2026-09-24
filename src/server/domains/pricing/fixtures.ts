/**
 * Dev catalogues — one priced `ShopCatalogue` per fixture shop, so `/order/new` and
 * `POST /api/v1/quotes` work on a laptop with no database.
 *
 * Two rules keep these honest:
 *
 * 1. **The codes are the real ones.** Every `code` here exists in migration 0011's
 *    `service_items` seed (`print_a4_bw_single`, `finish_spiral_binding`, …). A fixture
 *    that invented its own codes would let the engine pass here and fail against
 *    Postgres, which is the one thing a fixture must never do.
 * 2. **The rates match the published price list.** `discovery/fixtures.ts` shows a rate
 *    card on the shop profile; the number a customer reads there and the number the
 *    engine charges must be the same. `fixtures.test.ts` asserts it rather than trusting
 *    two hand-written files to stay in step.
 *
 * These are development data, not seed data. `scripts/seed.ts` writes the database from
 * the same shape, but nothing here is imported by production code paths — `source.ts`
 * decides, once, whether a request reads fixtures or Postgres.
 */

import type {
  CatalogueItem,
  CataloguePriceBand,
  ColourMode,
  FinishingCompatibility,
  PriceUnit,
  ServiceKind,
  ShopCatalogue,
  Sides,
} from './model'

/** Stable ids so a quote's `pricingBasis` is reproducible across restarts. */
const serviceItemId = (code: string) => `sitem-${code}`

const flat = (unitPricePaise: number, label: string | null = null): CataloguePriceBand[] => [
  { minQuantity: 1, maxQuantity: null, unitPricePaise: String(unitPricePaise), label },
]

/** A standard rate with a bulk rate above `bulkFrom` — how print shops actually quote. */
const banded = (
  unitPricePaise: number,
  bulkPricePaise: number,
  bulkFrom: number,
): CataloguePriceBand[] => [
  {
    minQuantity: 1,
    maxQuantity: bulkFrom - 1,
    unitPricePaise: String(unitPricePaise),
    label: 'Standard',
  },
  {
    minQuantity: bulkFrom,
    maxQuantity: null,
    unitPricePaise: String(bulkPricePaise),
    label: `Bulk (${bulkFrom}+)`,
  },
]

/** Defaults shared by every row, so a shop's entry states only what is unusual. */
function row(
  code: string,
  kind: ServiceKind,
  name: string,
  shortName: string,
  priceUnit: PriceUnit,
  bands: CataloguePriceBand[],
  overrides: Partial<CatalogueItem> = {},
): CatalogueItem {
  return {
    serviceItemId: serviceItemId(code),
    code,
    name,
    shortName,
    kind,
    paperSizeCode: null,
    colourMode: null,
    sides: null,
    priceUnit,
    appliesToPaperSizes: [],
    minPages: null,
    maxPages: null,
    autoPriceable: true,
    setupMinutes: 2,
    minutesPer100Units: 0,
    isAvailable: true,
    unavailableUntil: null,
    unavailableReason: null,
    setupFeePaise: '0',
    minChargePaise: '0',
    minQuantity: 1,
    maxQuantity: null,
    requiresQuote: false,
    quoteAboveQuantity: null,
    notes: null,
    bands,
    ...overrides,
  }
}

const SIZE_LABEL: Record<string, string> = { A4: 'A4', A3: 'A3', A5: 'A5', LEGAL: 'Legal' }
const COLOUR_LABEL: Record<ColourMode, string> = { bw: 'B&W', colour: 'Colour' }
const SIDES_LABEL: Record<Sides, string> = { single: 'single', double: 'double' }

/**
 * A print row, named and coded exactly as migration 0011 generates it:
 * `print_<size>_<mode>_<sides>`, `per_page`, minutes scaled by size.
 */
function print(
  size: string,
  colourMode: ColourMode,
  sides: Sides,
  bands: CataloguePriceBand[],
  overrides: Partial<CatalogueItem> = {},
): CatalogueItem {
  const code = `print_${size.toLowerCase()}_${colourMode}_${sides}`
  const label = `${SIZE_LABEL[size] ?? size} ${COLOUR_LABEL[colourMode]}`
  return row(code, 'print', `${label} (${SIDES_LABEL[sides]})`, label, 'per_page', bands, {
    paperSizeCode: size,
    colourMode,
    sides,
    minutesPer100Units: colourMode === 'colour' ? 12 : 5,
    ...overrides,
  })
}

/**
 * Both sides at the same per-page rate as one side.
 *
 * Indian shops quote per printed side, and duplex saves paper rather than toner — the
 * engine's sheet count records the paper saving, the rate does not pretend the ink was
 * free. A shop that genuinely discounts duplex overrides the rate on its own row.
 */
const printPair = (
  size: string,
  colourMode: ColourMode,
  bands: CataloguePriceBand[],
  overrides: Partial<CatalogueItem> = {},
): CatalogueItem[] => [
  print(size, colourMode, 'single', bands, overrides),
  print(size, colourMode, 'double', bands, overrides),
]

const spiral = (pricePaise: number, overrides: Partial<CatalogueItem> = {}) =>
  row(
    'finish_spiral_binding',
    'finishing',
    'Spiral Binding',
    'Spiral',
    'per_copy',
    flat(pricePaise),
    { minPages: 10, maxPages: 500, setupMinutes: 3, ...overrides },
  )

const softBind = (pricePaise: number, overrides: Partial<CatalogueItem> = {}) =>
  row('finish_soft_binding', 'finishing', 'Soft Binding', 'Soft bind', 'per_copy', flat(pricePaise), {
    minPages: 20,
    maxPages: 400,
    setupMinutes: 5,
    ...overrides,
  })

const hardBind = (pricePaise: number, overrides: Partial<CatalogueItem> = {}) =>
  row('finish_hard_binding', 'finishing', 'Hard Binding', 'Hard bind', 'per_copy', flat(pricePaise), {
    minPages: 20,
    maxPages: 600,
    setupMinutes: 15,
    ...overrides,
  })

const staple = (pricePaise: number, overrides: Partial<CatalogueItem> = {}) =>
  row('finish_staple', 'finishing', 'Stapling', 'Staple', 'per_copy', flat(pricePaise), {
    minPages: 2,
    maxPages: 60,
    setupMinutes: 1,
    ...overrides,
  })

const lamination = (pricePaise: number, overrides: Partial<CatalogueItem> = {}) =>
  row('finish_lamination', 'finishing', 'Lamination', 'Lamination', 'per_sheet', flat(pricePaise), {
    setupMinutes: 2,
    ...overrides,
  })

const scan = (pricePaise: number, colourMode: ColourMode = 'bw') =>
  row(
    colourMode === 'bw' ? 'scan_bw' : 'scan_colour',
    'scan',
    colourMode === 'bw' ? 'Scan to PDF' : 'Colour Scan to PDF',
    colourMode === 'bw' ? 'Scan' : 'Colour scan',
    'per_page',
    flat(pricePaise),
    { colourMode, setupMinutes: 3, minutesPer100Units: colourMode === 'bw' ? 8 : 14 },
  )

/**
 * A poster. `per_sqft` would need media dimensions the configure screen does not
 * collect, so the seeded rows are `per_sheet` and price a whole sheet.
 */
const poster = (size: string, pricePaise: number) =>
  row(
    `print_${size.toLowerCase()}_poster`,
    'print',
    `${size} Poster`,
    `${size} Poster`,
    'per_sheet',
    flat(pricePaise),
    { paperSizeCode: size, colourMode: 'colour', sides: 'single', setupMinutes: 5, minutesPer100Units: 300 },
  )

/** Which finishings a shop can apply at which sizes, with the comb's physical limit. */
function compat(
  entries: readonly (readonly [code: string, sizes: readonly string[], maxPages: number | null])[],
): FinishingCompatibility[] {
  return entries.flatMap(([finishingCode, sizes, maxPages]) =>
    sizes.map((paperSizeCode) => ({ finishingCode, paperSizeCode, maxPages })),
  )
}

/**
 * The catalogues, keyed by fixture shop slug.
 *
 * Each one is the same shop the discovery fixtures describe: same sizes, same finishings,
 * same rates, same per-order caps. A shop that cannot do colour has no colour row at all
 * rather than an unavailable one — "not offered" and "offered but switched off today" are
 * different sentences to a customer, and the engine says the right one for each.
 */
const CATALOGUES: Record<string, ShopCatalogue> = {
  // ── Shivaji Xerox, FC Road. The volume all-rounder. ───────────────────────
  'shivaji-xerox-fc-road': {
    shopId: '01924f10-0000-7000-8000-000000000001',
    shopSlug: 'shivaji-xerox-fc-road',
    minOrderPaise: '2000',
    maxPagesPerOrder: 600,
    maxFilesPerOrder: 15,
    paperSizes: ['A4', 'A3', 'LEGAL'],
    items: [
      ...printPair('A4', 'bw', banded(150, 100, 51)),
      ...printPair('A4', 'colour', flat(800)),
      ...printPair('A3', 'colour', flat(1600)),
      ...printPair('LEGAL', 'bw', flat(200)),
      spiral(4000),
      softBind(12000),
      staple(0),
      lamination(2000),
      scan(500),
    ],
    finishingCompatibility: compat([
      ['finish_spiral_binding', ['A4', 'A3', 'LEGAL'], 200],
      ['finish_soft_binding', ['A4', 'LEGAL'], 400],
      ['finish_staple', ['A4', 'A3', 'LEGAL'], 60],
      ['finish_lamination', ['A4', 'A3', 'LEGAL'], null],
    ]),
  },

  // ── Kothrud Digital Prints. Colour house; A3 and posters, small caps. ─────
  'kothrud-digital-prints': {
    shopId: '01924f10-0000-7000-8000-000000000002',
    shopSlug: 'kothrud-digital-prints',
    minOrderPaise: '5000',
    maxPagesPerOrder: 400,
    maxFilesPerOrder: 10,
    paperSizes: ['A4', 'A3', 'A5'],
    items: [
      ...printPair('A4', 'bw', flat(200)),
      // Colour-proofed over 20 pages, which is why the rate carries a setup fee.
      ...printPair('A4', 'colour', flat(1000), { setupFeePaise: '2000' }),
      ...printPair('A3', 'colour', flat(2500)),
      ...printPair('A5', 'bw', flat(150)),
      spiral(5000),
      staple(0),
      lamination(2500),
      poster('A2', 9000),
    ],
    finishingCompatibility: compat([
      ['finish_spiral_binding', ['A4', 'A3', 'A5'], 300],
      ['finish_staple', ['A4', 'A3', 'A5'], 60],
      ['finish_lamination', ['A4', 'A3', 'A5'], null],
    ]),
  },

  // ── Balaji Xerox, Swargate. One machine, B&W only, ₹1 a page. ─────────────
  'balaji-xerox-swargate': {
    shopId: '01924f10-0000-7000-8000-000000000003',
    shopSlug: 'balaji-xerox-swargate',
    minOrderPaise: '1000',
    maxPagesPerOrder: 300,
    maxFilesPerOrder: 8,
    paperSizes: ['A4', 'LEGAL'],
    items: [
      ...printPair('A4', 'bw', banded(100, 80, 51)),
      ...printPair('LEGAL', 'bw', flat(150)),
      // Free with a print job, and priced as such rather than hidden.
      staple(0),
    ],
    finishingCompatibility: compat([['finish_staple', ['A4', 'LEGAL'], 60]]),
  },

  // ── Aundh Print Hub. Project reports; high minimum, hard binding by hand. ─
  'aundh-print-hub': {
    shopId: '01924f10-0000-7000-8000-000000000004',
    shopSlug: 'aundh-print-hub',
    minOrderPaise: '15000',
    maxPagesPerOrder: 1200,
    maxFilesPerOrder: 6,
    paperSizes: ['A4', 'A3', 'LEGAL', 'LETTER'],
    items: [
      ...printPair('A4', 'bw', banded(180, 140, 51)),
      ...printPair('A4', 'colour', flat(900)),
      ...printPair('A3', 'bw', flat(300)),
      ...printPair('LEGAL', 'bw', flat(220)),
      ...printPair('LETTER', 'bw', flat(180)),
      spiral(4500),
      softBind(15000),
      // The published ₹350 is indicative: gold lettering is quoted after they see it.
      hardBind(35000, { requiresQuote: true }),
      lamination(2200),
    ],
    finishingCompatibility: compat([
      ['finish_spiral_binding', ['A4', 'A3', 'LEGAL', 'LETTER'], 250],
      ['finish_soft_binding', ['A4', 'LEGAL', 'LETTER'], 400],
      ['finish_hard_binding', ['A4', 'LEGAL', 'LETTER'], 600],
      ['finish_lamination', ['A4', 'A3', 'LEGAL', 'LETTER'], null],
    ]),
  },

  // ── Viman Nagar Copy Point. No caps of its own; platform caps apply. ──────
  'viman-nagar-copy-point': {
    shopId: '01924f10-0000-7000-8000-000000000005',
    shopSlug: 'viman-nagar-copy-point',
    minOrderPaise: '1500',
    maxPagesPerOrder: null,
    maxFilesPerOrder: null,
    paperSizes: ['A4', 'A3'],
    items: [
      ...printPair('A4', 'bw', flat(200)),
      ...printPair('A4', 'colour', flat(1000)),
      ...printPair('A3', 'bw', flat(350)),
      spiral(5000),
      staple(0),
      lamination(3000),
      scan(600),
    ],
    finishingCompatibility: compat([
      ['finish_spiral_binding', ['A4', 'A3'], 200],
      ['finish_staple', ['A4', 'A3'], 60],
      ['finish_lamination', ['A4', 'A3'], null],
    ]),
  },

  // ── Sadashiv Peth Book Print. Thesis work: cheap in bulk, big caps. ───────
  'sadashiv-peth-book-print': {
    shopId: '01924f10-0000-7000-8000-000000000006',
    shopSlug: 'sadashiv-peth-book-print',
    minOrderPaise: '10000',
    maxPagesPerOrder: 3000,
    maxFilesPerOrder: 20,
    paperSizes: ['A4', 'LEGAL'],
    items: [
      ...printPair('A4', 'bw', banded(120, 80, 51)),
      ...printPair('LEGAL', 'bw', flat(160)),
      spiral(3500),
      softBind(11000),
      staple(0),
    ],
    finishingCompatibility: compat([
      ['finish_spiral_binding', ['A4', 'LEGAL'], 200],
      ['finish_soft_binding', ['A4', 'LEGAL'], 400],
      ['finish_staple', ['A4', 'LEGAL'], 60],
    ]),
  },
}

/** Every dev catalogue, in the same order as the discovery fixtures. */
export const DEV_CATALOGUES: ShopCatalogue[] = Object.values(CATALOGUES)

/**
 * The catalogue for a shop, by slug or by id.
 *
 * Accepts both because `/order/new?shop=` carries a slug while `POST /api/v1/quotes`
 * carries the id — the same tolerance `findDevShop` has.
 */
export function findDevCatalogue(idOrSlug: string): ShopCatalogue | null {
  const key = idOrSlug.trim().toLowerCase()
  return (
    CATALOGUES[key] ??
    DEV_CATALOGUES.find((entry) => entry.shopId.toLowerCase() === key) ??
    null
  )
}


