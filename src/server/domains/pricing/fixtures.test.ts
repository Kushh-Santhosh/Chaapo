/**
 * The published rate card and the charged rate must be the same number.
 *
 * A shop profile shows `discovery/fixtures.ts`; a quote charges
 * `pricing/fixtures.ts`. Those are two hand-written files, and the failure mode when
 * they drift is the worst kind: the customer reads ₹1.50 a page, pays ₹2.00, and the
 * bug is invisible in both files on their own. This test is the join between them.
 *
 * It also guards the codes. Every code used here exists in migration 0011's seed, so a
 * fixture that quietly invents one fails before it can pass locally and break against
 * Postgres.
 */

import { describe, expect, it } from 'vitest'

import { DEV_SHOPS } from '../discovery/fixtures'
import { bandFor, findFinishingItem, findPrintItem } from './engine'
import { DEV_CATALOGUES, findDevCatalogue } from './fixtures'

/** Display code on the rate card → `service_items.code` the engine prices from. */
const CODE_MAP: Record<string, string> = {
  print_bw_a4: 'print_a4_bw_single',
  print_colour_a4: 'print_a4_colour_single',
  print_colour_a3: 'print_a3_colour_single',
  bind_spiral: 'finish_spiral_binding',
  bind_hard: 'finish_hard_binding',
  finish_lamination: 'finish_lamination',
  finish_staple: 'finish_staple',
  scan_a4: 'scan_bw',
  print_poster_a2: 'print_a2_poster',
}

describe('dev catalogues', () => {
  it('covers every fixture shop', () => {
    expect(DEV_CATALOGUES).toHaveLength(DEV_SHOPS.length)
    for (const shop of DEV_SHOPS) {
      expect(findDevCatalogue(shop.slug)).not.toBeNull()
    }
  })

  it('is findable by id as well as slug', () => {
    for (const shop of DEV_SHOPS) {
      expect(findDevCatalogue(shop.id)?.shopSlug).toBe(shop.slug)
    }
  })

  it('agrees with the discovery fixtures on shop identity', () => {
    for (const shop of DEV_SHOPS) {
      const cat = findDevCatalogue(shop.slug)!
      expect(cat.shopId).toBe(shop.id)
      expect(cat.minOrderPaise).toBe(shop.minOrderValuePaise)
      expect(cat.maxPagesPerOrder).toBe(shop.maxPagesPerOrder)
      expect(cat.maxFilesPerOrder).toBe(shop.maxFilesPerOrder)
    }
  })

  it('offers exactly the paper sizes the profile advertises', () => {
    for (const shop of DEV_SHOPS) {
      const cat = findDevCatalogue(shop.slug)!
      const advertised = [...shop.capabilities.paperSizes].map((size) => size.toUpperCase()).sort()
      expect([...cat.paperSizes].sort()).toEqual(advertised)
      // And every advertised size has at least one print row behind it.
      for (const size of cat.paperSizes) {
        const priced = cat.items.some(
          (entry) => entry.kind === 'print' && entry.paperSizeCode?.toUpperCase() === size,
        )
        expect(priced).toBe(true)
      }
    }
  })

  it('charges the rate the profile publishes', () => {
    for (const shop of DEV_SHOPS) {
      const cat = findDevCatalogue(shop.slug)!
      for (const group of shop.priceList) {
        for (const listed of group.items) {
          const code = CODE_MAP[listed.code]
          expect(code, `unmapped rate-card code ${listed.code}`).toBeDefined()
          const priced = cat.items.find((entry) => entry.code === code)
          expect(priced, `${shop.slug} publishes ${listed.code} but does not price it`).toBeDefined()
          // The headline rate is the first band — what a one-off job pays.
          expect(priced!.bands[0]?.unitPricePaise, `${shop.slug} ${listed.code}`).toBe(
            listed.pricePaise,
          )
        }
      }
    }
  })

  it('charges the bulk rate the profile publishes', () => {
    for (const shop of DEV_SHOPS) {
      const cat = findDevCatalogue(shop.slug)!
      for (const group of shop.priceList) {
        for (const listed of group.items) {
          if (listed.tiers.length < 2) continue
          const priced = cat.items.find((entry) => entry.code === CODE_MAP[listed.code])!
          for (const tier of listed.tiers) {
            const band = bandFor(priced.bands, tier.fromQuantity)
            expect(band?.unitPricePaise, `${shop.slug} ${listed.code} @${tier.fromQuantity}`).toBe(
              tier.pricePaise,
            )
            expect(band?.minQuantity).toBe(tier.fromQuantity)
            expect(band?.maxQuantity).toBe(tier.toQuantity)
          }
        }
      }
    }
  })

  it('can price the cheapest thing the shop card promises', () => {
    // Every card's "from ₹X/page" is labelled B&W A4, so it must be the cheapest B&W A4
    // rate the shop will actually charge — including its bulk band. A card promising a
    // rate no quote can reach is an advertised price the shop never agreed to.
    for (const shop of DEV_SHOPS) {
      if (!shop.fromPrice) continue
      const cat = findDevCatalogue(shop.slug)!
      expect(shop.fromPrice.label, shop.slug).toContain('B&W A4')
      const a4bw = findPrintItem(cat, 'A4', 'bw', 'single')!
      const cheapest = a4bw.bands
        .map((band) => BigInt(band.unitPricePaise))
        .reduce((low, value) => (value < low ? value : low))
      expect(String(cheapest), shop.slug).toBe(shop.fromPrice.pricePaise)
    }
  })

  it('can price a plain A4 B&W job at every shop', () => {
    for (const cat of DEV_CATALOGUES) {
      const item = findPrintItem(cat, 'A4', 'bw', 'single')
      expect(item, cat.shopSlug).not.toBeNull()
      expect(bandFor(item!.bands, 10), cat.shopSlug).not.toBeNull()
    }
  })

  it('prices both sides wherever it prices one', () => {
    for (const cat of DEV_CATALOGUES) {
      // Posters are excluded on purpose: they are `per_sheet` and single-sided, because
      // nobody duplex-prints a poster.
      const documents = cat.items.filter(
        (entry) => entry.kind === 'print' && entry.priceUnit === 'per_page' && entry.sides === 'single',
      )
      for (const item of documents) {
        const duplex = findPrintItem(cat, item.paperSizeCode!, item.colourMode!, 'double')
        expect(duplex?.sides, `${cat.shopSlug} ${item.code}`).toBe('double')
      }
    }
  })

  it('only claims a finishing the profile lists, and only at a size it prints', () => {
    for (const shop of DEV_SHOPS) {
      const cat = findDevCatalogue(shop.slug)!
      const advertised = new Set(shop.capabilities.finishings)
      for (const item of cat.items.filter((entry) => entry.kind === 'finishing')) {
        const bare = item.code.replace(/^finish_/, '').replace(/_binding$/, '_bind')
        const known = advertised.has(bare) || advertised.has(bare.replace('_bind', ''))
        expect(known, `${shop.slug} prices ${item.code} but does not advertise it`).toBe(true)
      }
      for (const compat of cat.finishingCompatibility) {
        expect(findFinishingItem(cat, compat.finishingCode), compat.finishingCode).not.toBeNull()
        expect(cat.paperSizes, `${shop.slug} ${compat.finishingCode}`).toContain(
          compat.paperSizeCode,
        )
      }
    }
  })

  it('gives every priced row at least one band', () => {
    for (const cat of DEV_CATALOGUES) {
      for (const item of cat.items) {
        expect(item.bands.length, `${cat.shopSlug} ${item.code}`).toBeGreaterThan(0)
        // Bands must be ordered and must not overlap, or `bandFor` picks by accident.
        let previousCeiling = 0
        for (const band of item.bands) {
          expect(band.minQuantity, `${cat.shopSlug} ${item.code}`).toBe(previousCeiling + 1)
          previousCeiling = band.maxQuantity ?? Number.MAX_SAFE_INTEGER
        }
      }
    }
  })

  it('uses only service_items codes seeded by migration 0011', () => {
    const SEEDED = /^(print_(a4|a3|a5|legal|fs|letter)_(bw|colour)_(single|double)|print_(a2|a1|a0)_poster|finish_(spiral_binding|soft_binding|hard_binding|staple|punching|lamination|cover_page)|scan_(bw|colour)|handling_(packaging|urgent)|quote_custom_job)$/
    for (const cat of DEV_CATALOGUES) {
      for (const item of cat.items) {
        expect(SEEDED.test(item.code), `${cat.shopSlug} ${item.code}`).toBe(true)
      }
    }
  })
})
