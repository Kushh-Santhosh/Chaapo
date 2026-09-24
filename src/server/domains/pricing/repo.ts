/**
 * A shop's priced catalogue, from Postgres.
 *
 * Loaded lazily by `service.ts` (`await import('./repo')`) so that a laptop with no
 * `DATABASE_URL` never pulls drizzle or `pg` into the process — the dev-fixture path
 * exists precisely so quoting works before any of that is configured.
 *
 * Three things here are deliberate:
 *
 * 1. **Unavailable items are loaded, not filtered out.** The engine distinguishes "this
 *    shop has not published a rate for A3 colour" from "this shop's colour machine is
 *    down until Tuesday", and it can only do that if the row is present with
 *    `isAvailable: false`. Filtering on availability in SQL would silently turn every
 *    temporary outage into a missing-rate error. Only `service_items.is_active` is
 *    filtered, because a de-listed platform item genuinely has no rate.
 * 2. **Bands are read whole and ordered by `minQuantity`.** `CatalogueItem.bands` is
 *    documented as ordered, and `bandFor()` in the engine relies on it. An item with no
 *    bands is returned with an empty array rather than dropped, so the engine reports
 *    `item_not_priced` instead of the shop appearing not to offer the service.
 * 3. **Money leaves as decimal strings of paise.** The driver hands back `bigint`;
 *    `ShopCatalogue` is serialisable end to end so a quote can cross the RSC boundary
 *    and be stored verbatim in `orders.price_snapshot`.
 *
 * Accepts a uuid or a slug because `/order/new?shop=` carries a slug while the quote
 * endpoint carries an id — the same dual lookup `discovery/repo.ts` does.
 */

import { and, asc, eq } from 'drizzle-orm'

import { getDb, type DbHandle } from '../../db/client'
import {
  priceBands,
  serviceItems,
  shopFinishingCompatibility,
  shopServiceItems,
} from '../../db/schema/catalogue'
import { shopCapabilities, shops } from '../../db/schema/shops'

import type {
  CatalogueItem,
  CataloguePriceBand,
  FinishingCompatibility,
  ShopCatalogue,
} from './model'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The shop's catalogue, or `null` if no such discoverable shop exists.
 *
 * `shops.discoverable` is the visibility predicate here for the same reason it is in
 * discovery: it is a generated column (live + verified + located + not deleted + not
 * suspended), so this module cannot quote for an unverified shop by forgetting a clause.
 */
export async function loadShopCatalogue(
  shopIdOrSlug: string,
  db: DbHandle = getDb(),
): Promise<ShopCatalogue | null> {
  const shopRows = await db
    .select({
      id: shops.id,
      slug: shops.slug,
      minOrderValuePaise: shops.minOrderValuePaise,
      maxPagesPerOrder: shops.maxPagesPerOrder,
      maxFilesPerOrder: shops.maxFilesPerOrder,
      paperSizes: shopCapabilities.paperSizes,
    })
    .from(shops)
    .leftJoin(shopCapabilities, eq(shopCapabilities.shopId, shops.id))
    .where(
      and(
        eq(shops.discoverable, true),
        UUID.test(shopIdOrSlug) ? eq(shops.id, shopIdOrSlug) : eq(shops.slug, shopIdOrSlug),
      ),
    )
    .limit(1)

  const shop = shopRows[0]
  if (!shop) return null

  const [items, finishingCompatibility] = await Promise.all([
    itemsFor(db, shop.id),
    finishingCompatibilityFor(db, shop.id),
  ])

  return {
    shopId: shop.id,
    shopSlug: shop.slug,
    minOrderPaise: shop.minOrderValuePaise.toString(),
    maxPagesPerOrder: shop.maxPagesPerOrder,
    maxFilesPerOrder: shop.maxFilesPerOrder,
    // No capabilities row means a shop mid-onboarding, which cannot be discoverable.
    // Defaulting keeps a join miss from throwing rather than inventing a capability.
    paperSizes: shop.paperSizes ?? [],
    items,
    finishingCompatibility,
  }
}

/**
 * One row per priced item, its bands folded in.
 *
 * A single query with a left join rather than one query per item: a shop's catalogue is
 * on the critical path of every price refresh on the configure screen, and forty items
 * with three bands each is one round trip, not forty.
 */
async function itemsFor(db: DbHandle, shopId: string): Promise<CatalogueItem[]> {
  const rows = await db
    .select({
      shopServiceItemId: shopServiceItems.id,
      serviceItemId: serviceItems.id,
      code: serviceItems.code,
      name: serviceItems.name,
      shortName: serviceItems.shortName,
      kind: serviceItems.kind,
      paperSizeCode: serviceItems.paperSizeCode,
      colourMode: serviceItems.colourMode,
      sides: serviceItems.sides,
      priceUnit: serviceItems.priceUnit,
      appliesToPaperSizes: serviceItems.appliesToPaperSizes,
      minPages: serviceItems.minPages,
      maxPages: serviceItems.maxPages,
      autoPriceable: serviceItems.autoPriceable,
      catalogueSetupMinutes: serviceItems.setupMinutes,
      catalogueMinutesPer100: serviceItems.minutesPer100Units,
      sortOrder: serviceItems.sortOrder,

      isAvailable: shopServiceItems.isAvailable,
      unavailableUntil: shopServiceItems.unavailableUntil,
      unavailableReason: shopServiceItems.unavailableReason,
      setupFeePaise: shopServiceItems.setupFeePaise,
      minChargePaise: shopServiceItems.minChargePaise,
      minQuantity: shopServiceItems.minQuantity,
      maxQuantity: shopServiceItems.maxQuantity,
      shopSetupMinutes: shopServiceItems.setupMinutes,
      shopMinutesPer100: shopServiceItems.minutesPer100Units,
      requiresQuote: shopServiceItems.requiresQuote,
      quoteAboveQuantity: shopServiceItems.quoteAboveQuantity,
      notes: shopServiceItems.notes,

      bandMinQuantity: priceBands.minQuantity,
      bandMaxQuantity: priceBands.maxQuantity,
      bandUnitPricePaise: priceBands.unitPricePaise,
      bandLabel: priceBands.label,
    })
    .from(shopServiceItems)
    .innerJoin(serviceItems, eq(serviceItems.id, shopServiceItems.serviceItemId))
    .leftJoin(priceBands, eq(priceBands.shopServiceItemId, shopServiceItems.id))
    .where(and(eq(shopServiceItems.shopId, shopId), eq(serviceItems.isActive, true)))
    .orderBy(asc(serviceItems.sortOrder), asc(serviceItems.code), asc(priceBands.minQuantity))

  const byShopItem = new Map<string, CatalogueItem>()

  for (const row of rows) {
    let item = byShopItem.get(row.shopServiceItemId)
    if (!item) {
      item = {
        serviceItemId: row.serviceItemId,
        code: row.code,
        name: row.name,
        shortName: row.shortName,
        kind: row.kind,
        paperSizeCode: row.paperSizeCode,
        colourMode: row.colourMode,
        sides: row.sides,
        priceUnit: row.priceUnit,
        appliesToPaperSizes: row.appliesToPaperSizes,
        minPages: row.minPages,
        maxPages: row.maxPages,
        autoPriceable: row.autoPriceable,
        // A shop's own throughput numbers win; the catalogue's are the day-one default.
        setupMinutes: row.shopSetupMinutes ?? row.catalogueSetupMinutes,
        minutesPer100Units: row.shopMinutesPer100 ?? row.catalogueMinutesPer100,
        isAvailable: row.isAvailable,
        unavailableUntil: row.unavailableUntil?.toISOString() ?? null,
        unavailableReason: row.unavailableReason,
        setupFeePaise: row.setupFeePaise.toString(),
        minChargePaise: row.minChargePaise.toString(),
        minQuantity: row.minQuantity,
        maxQuantity: row.maxQuantity,
        requiresQuote: row.requiresQuote,
        quoteAboveQuantity: row.quoteAboveQuantity,
        notes: row.notes,
        bands: [],
      }
      byShopItem.set(row.shopServiceItemId, item)
    }

    // The left join yields one all-null band row for an item with no bands.
    if (row.bandMinQuantity !== null && row.bandUnitPricePaise !== null) {
      const band: CataloguePriceBand = {
        minQuantity: row.bandMinQuantity,
        maxQuantity: row.bandMaxQuantity,
        unitPricePaise: row.bandUnitPricePaise.toString(),
        label: row.bandLabel,
      }
      item.bands.push(band)
    }
  }

  return [...byShopItem.values()]
}

/**
 * Which finishings this shop will apply to which print sizes.
 *
 * Absence of a row means "not offered" (FR-304), so this is a plain read with no
 * defaulting: inventing a row here would let the configure screen offer a binding the
 * shop cannot do.
 */
async function finishingCompatibilityFor(
  db: DbHandle,
  shopId: string,
): Promise<FinishingCompatibility[]> {
  const rows = await db
    .select({
      finishingCode: serviceItems.code,
      paperSizeCode: shopFinishingCompatibility.paperSizeCode,
      maxPages: shopFinishingCompatibility.maxPages,
    })
    .from(shopFinishingCompatibility)
    .innerJoin(serviceItems, eq(serviceItems.id, shopFinishingCompatibility.finishingItemId))
    .where(and(eq(shopFinishingCompatibility.shopId, shopId), eq(serviceItems.isActive, true)))
    .orderBy(asc(serviceItems.code), asc(shopFinishingCompatibility.paperSizeCode))

  return rows.map((row) => ({
    finishingCode: row.finishingCode,
    paperSizeCode: row.paperSizeCode,
    maxPages: row.maxPages,
  }))
}
