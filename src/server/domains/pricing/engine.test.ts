/**
 * The pricing engine's arithmetic, band selection, and every quote-required trigger.
 *
 * These tests are deliberately paranoid about two classes of bug that cost real money
 * and are invisible in a screenshot: billing a page twice (overlapping ranges, duplex
 * sheet counting) and pricing something the shop never agreed to print (a missing band
 * silently becoming free). Both are asserted directly rather than through a total.
 *
 * The catalogue is built by hand here rather than imported from fixtures, so a fixture
 * edit can never quietly change what a test claims.
 */

import { describe, expect, it } from 'vitest'

import { serializePaise } from '../../../lib/money'
import {
  bandFor,
  billingQuantity,
  computeQuote,
  countSelectedPages,
  countSheets,
  findFinishingItem,
  findPrintItem,
  isPayable,
  LARGE_JOB_PAGE_THRESHOLD,
  QUOTE_VALIDITY_MINUTES,
  roundToRupee,
  totalsFor,
  type PricingSettings,
} from './engine'
import type {
  CatalogueItem,
  CataloguePriceBand,
  QuoteItemInput,
  ShopCatalogue,
} from './model'

const NOW = new Date('2026-08-29T10:00:00.000Z')

const SETTINGS: PricingSettings = {
  customerPlatformFeePaise: 0n,
  platformFeeTaxRateBps: 1800,
  maxPagesPerOrder: 2000,
  maxFilesPerOrder: 10,
}

const flat = (pricePaise: string): CataloguePriceBand[] => [
  { minQuantity: 1, maxQuantity: null, unitPricePaise: pricePaise, label: null },
]

/** A catalogue row with everything permissive, so each test overrides only its subject. */
function item(overrides: Partial<CatalogueItem> & Pick<CatalogueItem, 'code'>): CatalogueItem {
  return {
    serviceItemId: `si-${overrides.code}`,
    name: overrides.code,
    shortName: null,
    kind: 'print',
    paperSizeCode: null,
    colourMode: null,
    sides: null,
    priceUnit: 'per_page',
    appliesToPaperSizes: [],
    minPages: null,
    maxPages: null,
    autoPriceable: true,
    setupMinutes: 0,
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
    bands: flat('100'),
    ...overrides,
  }
}

function catalogue(overrides: Partial<ShopCatalogue> = {}): ShopCatalogue {
  return {
    shopId: 'shop-1',
    shopSlug: 'test-shop',
    minOrderPaise: '0',
    maxPagesPerOrder: null,
    maxFilesPerOrder: null,
    paperSizes: ['A4'],
    items: [
      item({ code: 'print.a4.bw', paperSizeCode: 'A4', colourMode: 'bw', bands: flat('100') }),
      item({
        code: 'print.a4.colour',
        paperSizeCode: 'A4',
        colourMode: 'colour',
        bands: flat('800'),
      }),
      item({
        code: 'finishing.spiral',
        kind: 'finishing',
        priceUnit: 'per_copy',
        bands: flat('3000'),
      }),
    ],
    finishingCompatibility: [
      { finishingCode: 'finishing.spiral', paperSizeCode: 'A4', maxPages: 400 },
    ],
    ...overrides,
  }
}

function input(overrides: Partial<QuoteItemInput> = {}): QuoteItemInput {
  return {
    ref: 'r1',
    fileId: 'f1',
    paperSizeCode: 'A4',
    colourMode: 'bw',
    sides: 'single',
    copies: 1,
    documentPages: 10,
    ...overrides,
  }
}

/** Every block reason raised, so a test can assert on the set rather than on ordering. */
const reasonsOf = (items: QuoteItemInput[], cat = catalogue(), settings = SETTINGS) =>
  computeQuote({ shopId: cat.shopId, items }, cat, { now: NOW, settings }).blocks.map(
    (entry) => entry.reason,
  )

describe('countSelectedPages', () => {
  it('counts the whole document when no ranges are given', () => {
    expect(countSelectedPages(12)).toBe(12)
    expect(countSelectedPages(12, [])).toBe(12)
  })

  it('counts a subset', () => {
    expect(countSelectedPages(20, [{ from: 3, to: 7 }])).toBe(5)
  })

  it('counts overlapping ranges once', () => {
    // "1-5, 3-8" is pages 1 to 8 — eight pages. Adding the ranges up gives eleven,
    // which is the quiet overcharge this function exists to prevent.
    expect(countSelectedPages(20, [{ from: 1, to: 5 }, { from: 3, to: 8 }])).toBe(8)
    expect(countSelectedPages(20, [{ from: 1, to: 10 }, { from: 4, to: 6 }])).toBe(10)
  })

  it('merges adjacent and duplicate ranges', () => {
    expect(countSelectedPages(20, [{ from: 1, to: 5 }, { from: 6, to: 10 }])).toBe(10)
    expect(countSelectedPages(20, [{ from: 4, to: 4 }, { from: 4, to: 4 }])).toBe(1)
  })

  it('clamps to the document and ignores ranges past the end', () => {
    expect(countSelectedPages(10, [{ from: 8, to: 99 }])).toBe(3)
    expect(countSelectedPages(10, [{ from: 50, to: 60 }])).toBe(0)
    expect(countSelectedPages(10, [{ from: 0, to: 2 }])).toBe(2)
  })

  it('tolerates a reversed range', () => {
    expect(countSelectedPages(10, [{ from: 7, to: 3 }])).toBe(5)
  })

  it('is zero for an empty document', () => {
    expect(countSelectedPages(0)).toBe(0)
    expect(countSelectedPages(-3)).toBe(0)
  })

  it('handles unsorted input', () => {
    expect(countSelectedPages(30, [{ from: 20, to: 22 }, { from: 1, to: 2 }])).toBe(5)
  })
})

describe('countSheets', () => {
  it('is one sheet per page single-sided', () => {
    expect(countSheets(7, 'single', 1)).toBe(7)
  })

  it('pairs pages within a copy when duplex', () => {
    expect(countSheets(8, 'double', 1)).toBe(4)
  })

  it('still spends a whole sheet on an odd last page', () => {
    // 7 pages duplex is 4 sheets, not 3.5 — and 2 copies is 8, not 7.
    expect(countSheets(7, 'double', 1)).toBe(4)
    expect(countSheets(7, 'double', 2)).toBe(8)
  })

  it('is zero for nothing to print', () => {
    expect(countSheets(0, 'single', 3)).toBe(0)
    expect(countSheets(5, 'single', 0)).toBe(0)
  })
})

describe('bandFor', () => {
  const bands: CataloguePriceBand[] = [
    { minQuantity: 1, maxQuantity: 50, unitPricePaise: '200', label: 'Standard' },
    { minQuantity: 51, maxQuantity: 200, unitPricePaise: '150', label: 'Bulk' },
    { minQuantity: 201, maxQuantity: null, unitPricePaise: '100', label: 'Bulk (201+)' },
  ]

  it('picks the band containing the quantity', () => {
    expect(bandFor(bands, 10)?.label).toBe('Standard')
    expect(bandFor(bands, 120)?.label).toBe('Bulk')
  })

  it('is inclusive at both edges', () => {
    expect(bandFor(bands, 50)?.label).toBe('Standard')
    expect(bandFor(bands, 51)?.label).toBe('Bulk')
    expect(bandFor(bands, 200)?.label).toBe('Bulk')
    expect(bandFor(bands, 201)?.label).toBe('Bulk (201+)')
  })

  it('treats a null ceiling as "and above"', () => {
    expect(bandFor(bands, 5_000)?.unitPricePaise).toBe('100')
  })

  it('returns null rather than a free print when nothing covers the quantity', () => {
    // A shop that has not priced a quantity has not agreed to print it (§35.3).
    expect(bandFor(bands, 0)).toBeNull()
    expect(bandFor([], 10)).toBeNull()
    expect(bandFor([{ minQuantity: 10, maxQuantity: 20, unitPricePaise: '5', label: null }], 3))
      .toBeNull()
  })
})

describe('billingQuantity', () => {
  const counts = { selectedPages: 10, billableSides: 20, sheets: 5, copies: 2 }

  it('bills every printed side per page', () => {
    expect(billingQuantity('per_page', counts)).toBe(20)
  })

  it('bills sheets, copies and orders from their own counts', () => {
    expect(billingQuantity('per_sheet', counts)).toBe(5)
    expect(billingQuantity('per_copy', counts)).toBe(2)
    expect(billingQuantity('per_order', counts)).toBe(1)
  })

  it('refuses to price per square foot without media dimensions', () => {
    // Zero falls through to a quote-required block instead of pricing at ₹0.
    expect(billingQuantity('per_sqft', counts)).toBe(0)
  })
})

describe('roundToRupee', () => {
  it('rounds half up to whole rupees', () => {
    expect(roundToRupee(1049n)).toBe(1000n)
    expect(roundToRupee(1050n)).toBe(1100n)
    expect(roundToRupee(1051n)).toBe(1100n)
  })

  it('leaves whole rupees alone', () => {
    expect(roundToRupee(0n)).toBe(0n)
    expect(roundToRupee(1200n)).toBe(1200n)
  })

  it('rounds a refund away from zero the same way', () => {
    expect(roundToRupee(-1050n)).toBe(-1100n)
  })
})

describe('catalogue lookup', () => {
  it('matches on attributes, not on a composed code string', () => {
    const found = findPrintItem(catalogue(), 'A4', 'colour', 'single')
    expect(found?.code).toBe('print.a4.colour')
  })

  it('is case-insensitive about the paper size', () => {
    expect(findPrintItem(catalogue(), 'a4', 'bw', 'single')?.code).toBe('print.a4.bw')
  })

  it('prefers an exact sides match over a sides-agnostic row', () => {
    const cat = catalogue({
      items: [
        item({ code: 'either', paperSizeCode: 'A4', colourMode: 'bw', sides: null }),
        item({ code: 'duplex', paperSizeCode: 'A4', colourMode: 'bw', sides: 'double' }),
      ],
    })
    expect(findPrintItem(cat, 'A4', 'bw', 'double')?.code).toBe('duplex')
    expect(findPrintItem(cat, 'A4', 'bw', 'single')?.code).toBe('either')
  })

  it('returns null for a size the shop does not stock', () => {
    expect(findPrintItem(catalogue(), 'A2', 'bw', 'single')).toBeNull()
  })

  it('finds finishing items only among finishing rows', () => {
    expect(findFinishingItem(catalogue(), 'finishing.spiral')?.kind).toBe('finishing')
    expect(findFinishingItem(catalogue(), 'print.a4.bw')).toBeNull()
  })
})

describe('computeQuote — the happy path', () => {
  const quote = computeQuote(
    { shopId: 'shop-1', items: [input({ documentPages: 10, copies: 2 })] },
    catalogue(),
    { now: NOW, settings: SETTINGS },
  )

  it('bills every printed side once', () => {
    const breakdown = quote.items[0]!
    expect(breakdown.pages).toBe(10)
    expect(breakdown.billableSides).toBe(20)
    expect(breakdown.sheets).toBe(20)
  })

  it('produces one print line at the band rate', () => {
    const line = quote.items[0]!.lines.find((entry) => entry.kind === 'print')!
    expect(line.code).toBe('print.a4.bw')
    expect(line.quantity).toBe(20)
    expect(line.unit).toBe('per_page')
    expect(line.unitPricePaise).toBe('100')
    expect(line.amountPaise).toBe('2000')
  })

  it('adds the lines up to the item total', () => {
    const sum = quote.items[0]!.lines.reduce((acc, line) => acc + BigInt(line.amountPaise), 0n)
    expect(serializePaise(sum)).toBe(quote.items[0]!.totalPaise)
  })

  it('is payable and not quote-required', () => {
    expect(quote.quoteRequired).toBe(false)
    expect(quote.blocks).toHaveLength(0)
    expect(quote.totals.totalPaise).toBe('2000')
    expect(isPayable(quote)).toBe(true)
  })

  it('records the exact catalogue row and band it used', () => {
    expect(quote.pricingBasis).toHaveLength(1)
    expect(quote.pricingBasis[0]).toMatchObject({
      code: 'print.a4.bw',
      unitPricePaise: '100',
      bandMinQuantity: 1,
      bandMaxQuantity: null,
      quantity: 20,
    })
  })

  it('expires 30 minutes after it was computed', () => {
    const lifetime = new Date(quote.expiresAt).getTime() - new Date(quote.computedAt).getTime()
    expect(lifetime).toBe(QUOTE_VALIDITY_MINUTES * 60_000)
  })
})

describe('duplex', () => {
  it('halves sheets without halving billed pages', () => {
    const quote = computeQuote(
      { shopId: 'shop-1', items: [input({ documentPages: 9, sides: 'double' })] },
      catalogue(),
      { now: NOW, settings: SETTINGS },
    )
    const breakdown = quote.items[0]!
    expect(breakdown.billableSides).toBe(9)
    expect(breakdown.sheets).toBe(5)
    // Paper is cheaper; toner is not. Per-page pricing bills 9, not 5.
    expect(breakdown.totalPaise).toBe('900')
  })
})

describe('setup fee, minimum charge and rounding lines', () => {
  it('charges a setup fee once per file, before the print line', () => {
    const cat = catalogue({
      items: [
        item({
          code: 'print.a4.bw',
          paperSizeCode: 'A4',
          colourMode: 'bw',
          setupFeePaise: '500',
          bands: flat('100'),
        }),
      ],
    })
    const quote = computeQuote({ shopId: 'shop-1', items: [input()] }, cat, {
      now: NOW,
      settings: SETTINGS,
    })
    const kinds = quote.items[0]!.lines.map((line) => line.kind)
    expect(kinds).toEqual(['setup', 'print'])
    expect(quote.items[0]!.totalPaise).toBe('1500')
  })

  it('tops up to the shop minimum for the item and shows the top-up', () => {
    const cat = catalogue({
      items: [
        item({
          code: 'print.a4.bw',
          paperSizeCode: 'A4',
          colourMode: 'bw',
          minChargePaise: '1000',
          bands: flat('100'),
        }),
      ],
    })
    const quote = computeQuote(
      { shopId: 'shop-1', items: [input({ documentPages: 2 })] },
      cat,
      { now: NOW, settings: SETTINGS },
    )
    const topUp = quote.items[0]!.lines.find((line) => line.kind === 'min_charge')
    expect(topUp?.amountPaise).toBe('800')
    expect(quote.items[0]!.totalPaise).toBe('1000')
  })

  it('shows the rounding adjustment rather than hiding it', () => {
    const cat = catalogue({
      items: [
        item({ code: 'print.a4.bw', paperSizeCode: 'A4', colourMode: 'bw', bands: flat('33') }),
      ],
    })
    const quote = computeQuote(
      { shopId: 'shop-1', items: [input({ documentPages: 5 })] },
      cat,
      { now: NOW, settings: SETTINGS },
    )
    // 5 × ₹0.33 = ₹1.65 → ₹2.00, with the +₹0.35 written down.
    const rounding = quote.items[0]!.lines.find((line) => line.kind === 'rounding')
    expect(rounding?.amountPaise).toBe('35')
    expect(quote.items[0]!.totalPaise).toBe('200')
    const sum = quote.items[0]!.lines.reduce((acc, line) => acc + BigInt(line.amountPaise), 0n)
    expect(serializePaise(sum)).toBe('200')
  })

  it('rounds once at the item, not per line', () => {
    const cat = catalogue({
      items: [
        item({
          code: 'print.a4.bw',
          paperSizeCode: 'A4',
          colourMode: 'bw',
          bands: flat('33'),
          setupFeePaise: '17',
        }),
      ],
    })
    const quote = computeQuote(
      { shopId: 'shop-1', items: [input({ documentPages: 5 })] },
      cat,
      { now: NOW, settings: SETTINGS },
    )
    // 17 + 165 = 182 → ₹2. Rounding each line first would have given ₹2 + ₹0 = wrong shape.
    expect(quote.items[0]!.totalPaise).toBe('200')
  })
})

describe('finishing', () => {
  it('prices a compatible finish per copy', () => {
    const quote = computeQuote(
      {
        shopId: 'shop-1',
        items: [input({ copies: 3, finishings: [{ code: 'finishing.spiral' }] })],
      },
      catalogue(),
      { now: NOW, settings: SETTINGS },
    )
    const line = quote.items[0]!.lines.find((entry) => entry.kind === 'finishing')!
    expect(line.quantity).toBe(3)
    expect(line.amountPaise).toBe('9000')
    expect(quote.quoteRequired).toBe(false)
  })

  it('honours an explicit quantity but never below the shop minimum', () => {
    const cat = catalogue({
      items: [
        ...catalogue().items.filter((entry) => entry.kind === 'print'),
        item({
          code: 'finishing.spiral',
          kind: 'finishing',
          priceUnit: 'per_copy',
          minQuantity: 2,
          bands: flat('3000'),
        }),
      ],
    })
    const quote = computeQuote(
      {
        shopId: 'shop-1',
        items: [input({ finishings: [{ code: 'finishing.spiral', quantity: 1 }] })],
      },
      cat,
      { now: NOW, settings: SETTINGS },
    )
    expect(quote.items[0]!.lines.find((entry) => entry.kind === 'finishing')?.quantity).toBe(2)
  })

  it('adds the shop throughput estimate for both print and finishing', () => {
    const cat = catalogue({
      items: [
        item({
          code: 'print.a4.bw',
          paperSizeCode: 'A4',
          colourMode: 'bw',
          setupMinutes: 2,
          minutesPer100Units: 50,
          bands: flat('100'),
        }),
        item({
          code: 'finishing.spiral',
          kind: 'finishing',
          priceUnit: 'per_copy',
          setupMinutes: 3,
          bands: flat('3000'),
        }),
      ],
    })
    const quote = computeQuote(
      {
        shopId: 'shop-1',
        items: [input({ documentPages: 100, finishings: [{ code: 'finishing.spiral' }] })],
      },
      cat,
      { now: NOW, settings: SETTINGS },
    )
    // print: 2 + ceil(50 × 100 / 100) = 52; finishing: 3 + 0.
    expect(quote.estimatedMinutes).toBe(55)
  })
})

describe('quote-required triggers', () => {
  it('unreliable_page_count — a scanned PDF we could not count', () => {
    expect(reasonsOf([input({ pageCountUnreliable: true })])).toContain('unreliable_page_count')
  })

  it('unsupported_format — a file type nobody can price automatically', () => {
    expect(reasonsOf([input({ formatNotAutoPriceable: true })])).toContain('unsupported_format')
  })

  it('unsupported_format — a catalogue row the shop prices by hand', () => {
    const cat = catalogue({
      items: [
        item({ code: 'print.a4.bw', paperSizeCode: 'A4', colourMode: 'bw', requiresQuote: true }),
      ],
    })
    expect(reasonsOf([input()], cat)).toContain('unsupported_format')
  })

  it('large_job — over the page threshold', () => {
    const pages = LARGE_JOB_PAGE_THRESHOLD + 1
    expect(reasonsOf([input({ documentPages: pages })])).toContain('large_job')
  })

  it('large_job — copies push the printed sides over the threshold', () => {
    // 300 pages is fine; 300 × 2 copies is not.
    expect(reasonsOf([input({ documentPages: 300 })])).not.toContain('large_job')
    expect(reasonsOf([input({ documentPages: 300, copies: 2 })])).toContain('large_job')
  })

  it('large_job — the shop quotes above its own quantity threshold', () => {
    const cat = catalogue({
      items: [
        item({
          code: 'print.a4.bw',
          paperSizeCode: 'A4',
          colourMode: 'bw',
          quoteAboveQuantity: 5,
        }),
      ],
    })
    expect(reasonsOf([input({ documentPages: 6 })], cat)).toContain('large_job')
    expect(reasonsOf([input({ documentPages: 5 })], cat)).not.toContain('large_job')
  })

  it('finishing_needs_inspection — the custom-job code can never be auto-priced', () => {
    expect(reasonsOf([input({ finishings: [{ code: 'quote_custom_job' }] })])).toContain(
      'finishing_needs_inspection',
    )
  })

  it('finishing_needs_inspection — a finish the shop prices by hand', () => {
    // Data, not a hardcoded code list: a shop that has published a hard-bind rate gets
    // to quote it instantly, and one that has not gets asked.
    const handPriced = catalogue({
      items: [
        ...catalogue().items,
        item({
          code: 'finish_hard_binding',
          kind: 'finishing',
          shortName: 'Hard bind',
          priceUnit: 'per_copy',
          requiresQuote: true,
          bands: flat('35000'),
        }),
      ],
      finishingCompatibility: [
        ...catalogue().finishingCompatibility,
        { finishingCode: 'finish_hard_binding', paperSizeCode: 'A4', maxPages: 600 },
      ],
    })
    const asked = reasonsOf([input({ finishings: [{ code: 'finish_hard_binding' }] })], handPriced)
    expect(asked).toContain('finishing_needs_inspection')

    // The same shop with a committed rate prices it without a human.
    const committed = catalogue({
      items: handPriced.items.map((entry) =>
        entry.code === 'finish_hard_binding' ? { ...entry, requiresQuote: false } : entry,
      ),
      finishingCompatibility: handPriced.finishingCompatibility,
    })
    const quoted = computeQuote(
      { shopId: 'shop-1', items: [input({ finishings: [{ code: 'finish_hard_binding' }] })] },
      committed,
      { now: NOW, settings: SETTINGS },
    )
    expect(quoted.quoteRequired).toBe(false)
    expect(quoted.items[0]!.totalPaise).toBe('36000')
  })

  it('finishing_needs_inspection — a finish flagged not auto-priceable', () => {
    const cat = catalogue({
      items: catalogue().items.map((entry) =>
        entry.kind === 'finishing' ? { ...entry, autoPriceable: false } : entry,
      ),
    })
    expect(reasonsOf([input({ finishings: [{ code: 'finishing.spiral' }] })], cat)).toContain(
      'finishing_needs_inspection',
    )
  })

  it('finishing_not_offered — the finish exists but not at this paper size', () => {
    const cat = catalogue({
      paperSizes: ['A4', 'A3'],
      items: [
        ...catalogue().items,
        item({ code: 'print.a3.bw', paperSizeCode: 'A3', colourMode: 'bw' }),
      ],
    })
    const reasons = reasonsOf(
      [input({ paperSizeCode: 'A3', finishings: [{ code: 'finishing.spiral' }] })],
      cat,
    )
    expect(reasons).toContain('finishing_not_offered')
  })

  it('item_not_priced — no rate for the size and colour asked for', () => {
    expect(reasonsOf([input({ paperSizeCode: 'A2' })])).toContain('item_not_priced')
  })

  it('item_not_priced — a rate exists but no band covers the quantity', () => {
    const cat = catalogue({
      items: [
        item({
          code: 'print.a4.bw',
          paperSizeCode: 'A4',
          colourMode: 'bw',
          bands: [{ minQuantity: 50, maxQuantity: 100, unitPricePaise: '90', label: null }],
        }),
      ],
    })
    const quote = computeQuote({ shopId: 'shop-1', items: [input({ documentPages: 10 })] }, cat, {
      now: NOW,
      settings: SETTINGS,
    })
    expect(quote.blocks.map((entry) => entry.reason)).toContain('item_not_priced')
    // Crucially, it is not priced at zero.
    expect(quote.items[0]!.lines).toHaveLength(0)
    expect(quote.totals.totalPaise).toBe('0')
    expect(isPayable(quote)).toBe(false)
  })

  it('item_unavailable — the shop has switched the item off', () => {
    const cat = catalogue({
      items: [
        item({
          code: 'print.a4.bw',
          paperSizeCode: 'A4',
          colourMode: 'bw',
          isAvailable: false,
          unavailableReason: 'Colour drum on order',
        }),
      ],
    })
    const quote = computeQuote({ shopId: 'shop-1', items: [input()] }, cat, {
      now: NOW,
      settings: SETTINGS,
    })
    expect(quote.blocks[0]?.reason).toBe('item_unavailable')
    expect(quote.blocks[0]?.message).toBe('Colour drum on order')
  })

  it('item_unavailable — only while the unavailable-until window is open', () => {
    const build = (until: string) =>
      catalogue({
        items: [
          item({
            code: 'print.a4.bw',
            paperSizeCode: 'A4',
            colourMode: 'bw',
            unavailableUntil: until,
          }),
        ],
      })
    expect(reasonsOf([input()], build('2026-08-29T12:00:00.000Z'))).toContain('item_unavailable')
    expect(reasonsOf([input()], build('2026-08-29T09:00:00.000Z'))).not.toContain(
      'item_unavailable',
    )
  })

  it('outside_item_bounds — below the shop per-file page floor', () => {
    const cat = catalogue({
      items: [
        item({ code: 'print.a4.bw', paperSizeCode: 'A4', colourMode: 'bw', minPages: 5 }),
      ],
    })
    expect(reasonsOf([input({ documentPages: 2 })], cat)).toContain('outside_item_bounds')
  })

  it('outside_item_bounds — past the finishing page cap', () => {
    const reasons = reasonsOf([
      input({ documentPages: 450, finishings: [{ code: 'finishing.spiral' }] }),
    ])
    expect(reasons).toContain('outside_item_bounds')
  })

  it('over_shop_limit — past the platform page cap', () => {
    const settings: PricingSettings = { ...SETTINGS, maxPagesPerOrder: 5 }
    const reasons = reasonsOf([input({ documentPages: 10 })], catalogue(), settings)
    expect(reasons).toContain('over_shop_limit')
  })

  it("over_shop_limit — past the shop's own page cap", () => {
    const cat = catalogue({ maxPagesPerOrder: 5 })
    expect(reasonsOf([input({ documentPages: 10 })], cat)).toContain('over_shop_limit')
  })

  it("over_shop_limit — past the shop's own file cap", () => {
    const cat = catalogue({ maxFilesPerOrder: 1 })
    const reasons = reasonsOf([input({ ref: 'a' }), input({ ref: 'b', fileId: 'f2' })], cat)
    expect(reasons).toContain('over_shop_limit')
  })

  it('marks the quote as requiring a human and names the item at fault', () => {
    const quote = computeQuote(
      { shopId: 'shop-1', items: [input({ ref: 'card-7', pageCountUnreliable: true })] },
      catalogue(),
      { now: NOW, settings: SETTINGS },
    )
    expect(quote.quoteRequired).toBe(true)
    expect(quote.blocks[0]?.itemRef).toBe('card-7')
    expect(isPayable(quote)).toBe(false)
  })

  it('gives every block a sentence a customer can act on', () => {
    const quote = computeQuote(
      {
        shopId: 'shop-1',
        items: [
          input({ pageCountUnreliable: true, formatNotAutoPriceable: true }),
          input({ ref: 'r2', fileId: 'f2', paperSizeCode: 'A2' }),
        ],
      },
      catalogue(),
      { now: NOW, settings: SETTINGS },
    )
    expect(quote.blocks.length).toBeGreaterThan(2)
    for (const entry of quote.blocks) {
      expect(entry.message.length).toBeGreaterThan(10)
      expect(entry.message).toMatch(/\.$/)
    }
  })

  it('still prices the items it understands alongside the blocked one', () => {
    const quote = computeQuote(
      {
        shopId: 'shop-1',
        items: [input(), input({ ref: 'r2', fileId: 'f2', paperSizeCode: 'A2' })],
      },
      catalogue(),
      { now: NOW, settings: SETTINGS },
    )
    expect(quote.items[0]!.totalPaise).toBe('1000')
    expect(quote.items[1]!.totalPaise).toBe('0')
    expect(quote.quoteRequired).toBe(true)
  })
})

describe('totalsFor', () => {
  const priced = (total: string) => ({
    ref: 'r1',
    fileId: 'f1',
    label: 'A4',
    pages: 10,
    billableSides: 10,
    sheets: 10,
    copies: 1,
    lines: [],
    totalPaise: total,
  })

  it('leaves a basket above the minimum alone', () => {
    const totals = totalsFor([priced('5000')], catalogue({ minOrderPaise: '2000' }), SETTINGS)
    expect(totals.itemsSubtotalPaise).toBe('5000')
    expect(totals.minOrderTopUpPaise).toBe('0')
    expect(totals.subtotalPaise).toBe('5000')
  })

  it('tops a small basket up to the shop minimum as its own line item', () => {
    const totals = totalsFor([priced('500')], catalogue({ minOrderPaise: '2000' }), SETTINGS)
    expect(totals.minOrderTopUpPaise).toBe('1500')
    expect(totals.subtotalPaise).toBe('2000')
  })

  it('does not charge an empty basket the shop minimum', () => {
    const totals = totalsFor([], catalogue({ minOrderPaise: '2000' }), SETTINGS)
    expect(totals.itemsSubtotalPaise).toBe('0')
    expect(totals.subtotalPaise).toBe('0')
    expect(totals.minOrderTopUpPaise).toBe('0')
    expect(totals.totalPaise).toBe('0')
  })

  it('hides the platform fee under the shop-side commission model', () => {
    const totals = totalsFor([priced('5000')], catalogue(), SETTINGS)
    expect(totals.platformFeePaise).toBe('0')
    expect(totals.taxPaise).toBe('0')
    expect(totals.totalPaise).toBe('5000')
  })

  it('taxes the platform fee only, never the shop price', () => {
    const settings: PricingSettings = { ...SETTINGS, customerPlatformFeePaise: 1000n }
    const totals = totalsFor([priced('5000')], catalogue(), settings)
    expect(totals.platformFeePaise).toBe('1000')
    expect(totals.taxPaise).toBe('180')
    expect(totals.totalPaise).toBe('6180')
  })

  it('charges no platform fee on an empty basket', () => {
    const settings: PricingSettings = { ...SETTINGS, customerPlatformFeePaise: 1000n }
    expect(totalsFor([], catalogue(), settings).totalPaise).toBe('0')
  })
})

describe('input hardening', () => {
  it('treats a nonsense copy count as one copy', () => {
    const quote = computeQuote(
      { shopId: 'shop-1', items: [input({ copies: 0 })] },
      catalogue(),
      { now: NOW, settings: SETTINGS },
    )
    expect(quote.items[0]!.copies).toBe(1)
  })

  it('floors a fractional copy count', () => {
    const quote = computeQuote(
      { shopId: 'shop-1', items: [input({ copies: 2.7 })] },
      catalogue(),
      { now: NOW, settings: SETTINGS },
    )
    expect(quote.items[0]!.copies).toBe(2)
  })

  it('never reads a price from the request — there is nowhere to put one', () => {
    // FR-303 as a type-level fact, asserted at runtime so a future field cannot sneak in.
    const keys = Object.keys(input({ finishings: [{ code: 'finishing.spiral' }] }))
    expect(keys.some((key) => /price|amount|paise|total/i.test(key))).toBe(false)
  })

  it('returns an empty, unpayable quote for an empty request', () => {
    const quote = computeQuote({ shopId: 'shop-1', items: [] }, catalogue(), {
      now: NOW,
      settings: SETTINGS,
    })
    expect(quote.items).toHaveLength(0)
    expect(quote.quoteRequired).toBe(false)
    expect(quote.totals.totalPaise).toBe('0')
    // Not quote-required, but still not chargeable.
    expect(isPayable(quote)).toBe(false)
  })
})








