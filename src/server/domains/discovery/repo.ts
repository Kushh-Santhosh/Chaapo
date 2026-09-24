/**
 * Discovery, against Postgres.
 *
 * Loaded lazily by `service.ts` so a laptop without a database never pulls in the
 * driver. Three things about this file are deliberate:
 *
 * 1. **`shops.discoverable` is the only visibility predicate.** It is a generated
 *    column (live + verified + located + not deleted + not suspended), so this module
 *    cannot accidentally admit an unverified shop by forgetting a clause, and the rule
 *    has exactly one definition — in migration 0003.
 * 2. **Distance is PostGIS, in the database.** `ST_DWithin` on a `geography` column
 *    uses the GiST index; filtering in TypeScript would mean fetching every shop in
 *    India to show six.
 * 3. **Two round trips, not N+1.** The shop page is one query; hours, capabilities and
 *    headline prices for that page are batched by `shop_id IN (…)`. Discovery is the
 *    hottest read in the product and has a 3 s first-paint budget on 4G (NFR-02).
 *
 * `photoKey`/`photoKeys` are `null`/`[]` here on purpose. There is no public shop-photo
 * table yet, and the only shop images in the schema live on `shop_kyc`
 * (`shop_photo_key`, `signboard_photo_key`) — KYC evidence, which must never be served
 * to a customer. Until a public gallery table and the signed-URL image proxy exist, the
 * cards render their typographic fallback tile rather than borrowing private evidence.
 */

import { and, asc, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm'

import type { HoursInterval, WeeklyHours } from '../../../lib/time'
import { getDb, type DbHandle } from '../../db/client'
import { priceBands, serviceItems, shopServiceItems } from '../../db/schema/catalogue'
import { cities, localities } from '../../db/schema/geo'
import { users } from '../../db/schema/identity'
import { orderRatings } from '../../db/schema/orders'
import { shopCapabilities, shopClosures, shopHours, shops } from '../../db/schema/shops'

import {
  DEFAULT_RADIUS_METRES,
  MAX_RADIUS_METRES,
  type DiscoveryQuery,
  type DiscoveryResult,
  type ShopCapabilitySummary,
  type ShopDetail,
  type ShopPriceGroup,
  type ShopReview,
  type ShopSummary,
} from './model'
import { applyFilters, encodeCursor, sortShops } from './service'

/** The columns every shop view needs. Kept in one place so the two queries agree. */
const shopColumns = {
  id: shops.id,
  slug: shops.slug,
  name: shops.name,
  tagline: shops.tagline,
  about: shops.about,
  addressLine1: shops.addressLine1,
  addressLine2: shops.addressLine2,
  landmark: shops.landmark,
  pincode: shops.pincode,
  ratingAvgCenti: shops.ratingAvgCenti,
  ratingCount: shops.ratingCount,
  ordersCompleted: shops.ordersCompleted,
  medianReadyMinutes: shops.medianReadyMinutes,
  defaultTurnaroundMinutes: shops.defaultTurnaroundMinutes,
  acceptWindowMinutes: shops.acceptWindowMinutes,
  pickupGraceHours: shops.pickupGraceHours,
  minOrderValuePaise: shops.minOrderValuePaise,
  maxPagesPerOrder: shops.maxPagesPerOrder,
  maxFilesPerOrder: shops.maxFilesPerOrder,
  pausedUntil: shops.pausedUntil,
  pauseReason: shops.pauseReason,
  verifiedAt: shops.verifiedAt,
  showPhoneToCustomer: shops.showPhoneToCustomer,
  contactPhoneMasked: shops.contactPhoneMasked,
  localityName: localities.name,
  cityName: cities.name,
} as const

const NO_CAPABILITIES: ShopCapabilitySummary = {
  paperSizes: ['a4'],
  colour: false,
  bw: true,
  duplex: true,
  finishings: [],
  cardStock: false,
  photoPaper: false,
  largeFormat: false,
  scanning: false,
  printerCount: 1,
}

/**
 * Longitude first.
 *
 * `ST_MakePoint` takes (x, y) — that is (lon, lat) — and getting it backwards puts
 * every Pune shop in the Indian Ocean while still returning plausible-looking numbers.
 * Written once, here, so there is one chance to get it wrong instead of four.
 */
function pointOf(origin: { latitude: number; longitude: number }) {
  return sql`ST_SetSRID(ST_MakePoint(${origin.longitude}, ${origin.latitude}), 4326)::geography`
}

// ── Batched side queries ────────────────────────────────────────────────────

async function hoursFor(db: DbHandle, shopIds: string[]): Promise<Map<string, WeeklyHours>> {
  const empty = (): WeeklyHours => [[], [], [], [], [], [], []]
  const byShop = new Map<string, HoursInterval[][]>()
  if (shopIds.length === 0) return new Map()

  const rows = await db
    .select({
      shopId: shopHours.shopId,
      weekday: shopHours.weekday,
      openMinute: shopHours.openMinute,
      closeMinute: shopHours.closeMinute,
    })
    .from(shopHours)
    .where(inArray(shopHours.shopId, shopIds))
    .orderBy(asc(shopHours.weekday), asc(shopHours.openMinute))

  for (const row of rows) {
    let week = byShop.get(row.shopId)
    if (!week) {
      week = [[], [], [], [], [], [], []]
      byShop.set(row.shopId, week)
    }
    const day = week[row.weekday]
    if (day) day.push({ open: row.openMinute, close: row.closeMinute })
  }

  const result = new Map<string, WeeklyHours>()
  for (const shopId of shopIds) result.set(shopId, byShop.get(shopId) ?? empty())
  return result
}

async function capabilitiesFor(
  db: DbHandle,
  shopIds: string[],
): Promise<Map<string, ShopCapabilitySummary>> {
  const result = new Map<string, ShopCapabilitySummary>()
  if (shopIds.length === 0) return result

  const rows = await db
    .select()
    .from(shopCapabilities)
    .where(inArray(shopCapabilities.shopId, shopIds))

  for (const row of rows) {
    result.set(row.shopId, {
      paperSizes: row.paperSizes,
      colour: row.supportsColour,
      bw: row.supportsBw,
      duplex: row.supportsDuplex,
      finishings: row.finishings,
      cardStock: row.supportsCardStock,
      photoPaper: row.supportsPhotoPaper,
      largeFormat: row.supportsLargeFormat,
      scanning: row.supportsScanning,
      printerCount: row.printerCount,
    })
  }
  // A shop with no capabilities row is a shop mid-onboarding; it cannot be
  // discoverable, but defaulting keeps a join miss from crashing the page.
  for (const shopId of shopIds) {
    if (!result.has(shopId)) result.set(shopId, NO_CAPABILITIES)
  }
  return result
}

/**
 * The "from ₹x/page" teaser: the shop's cheapest single-sided B&W A4 band.
 *
 * Explicitly the *cheapest band*, which is the bulk rate, and the label says so
 * ("B&W A4 · 500+"). Showing the cheapest rate without saying what it applies to is
 * the sort of teaser that turns into a dispute at the counter (PRD §11).
 */
async function fromPricesFor(db: DbHandle, shopIds: string[]) {
  const result = new Map<string, ShopSummary['fromPrice']>()
  if (shopIds.length === 0) return result

  const rows = await db
    .select({
      shopId: shopServiceItems.shopId,
      unitPricePaise: priceBands.unitPricePaise,
      minQuantity: priceBands.minQuantity,
      priceUnit: serviceItems.priceUnit,
      shortName: serviceItems.shortName,
      name: serviceItems.name,
    })
    .from(shopServiceItems)
    .innerJoin(serviceItems, eq(serviceItems.id, shopServiceItems.serviceItemId))
    .innerJoin(priceBands, eq(priceBands.shopServiceItemId, shopServiceItems.id))
    .where(
      and(
        inArray(shopServiceItems.shopId, shopIds),
        eq(shopServiceItems.isAvailable, true),
        eq(serviceItems.kind, 'print'),
        eq(serviceItems.colourMode, 'bw'),
        eq(serviceItems.paperSizeCode, 'a4'),
        eq(serviceItems.isActive, true),
      ),
    )
    .orderBy(asc(shopServiceItems.shopId), asc(priceBands.unitPricePaise))

  for (const row of rows) {
    // Ordered cheapest-first per shop, so the first row wins and the rest are skipped.
    if (result.has(row.shopId)) continue
    const bulk = row.minQuantity > 1 ? ` · ${row.minQuantity}+` : ''
    result.set(row.shopId, {
      pricePaise: row.unitPricePaise.toString(),
      unit: row.priceUnit === 'per_sheet' ? 'sheet' : row.priceUnit === 'per_copy' ? 'copy' : 'page',
      label: `${row.shortName ?? row.name}${bulk}`,
    })
  }
  for (const shopId of shopIds) if (!result.has(shopId)) result.set(shopId, null)
  return result
}

// ── Search ──────────────────────────────────────────────────────────────────

export async function searchShopsInDatabase(
  query: DiscoveryQuery,
  offset: number,
  now: Date,
): Promise<DiscoveryResult> {
  const db = getDb()
  const limit = query.limit ?? 20
  const requested = query.origin?.radiusMetres ?? DEFAULT_RADIUS_METRES

  let radius = requested
  let widened = false
  let rows = await selectShops(db, query, radius)

  // Widen rather than show an empty screen. The caller tells the customer we did.
  while (rows.length === 0 && query.origin && radius < MAX_RADIUS_METRES) {
    radius = Math.min(radius * 2, MAX_RADIUS_METRES)
    widened = true
    rows = await selectShops(db, query, radius)
  }

  const shopIds = rows.map((row) => row.id)
  const [hours, capabilities, fromPrices] = await Promise.all([
    hoursFor(db, shopIds),
    capabilitiesFor(db, shopIds),
    fromPricesFor(db, shopIds),
  ])

  const summaries: ShopSummary[] = rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    localityName: row.localityName,
    cityName: row.cityName,
    distanceMetres: row.distanceMetres === null ? null : Math.round(row.distanceMetres),
    ratingAvgCenti: row.ratingAvgCenti,
    ratingCount: row.ratingCount,
    ordersCompleted: row.ordersCompleted,
    medianReadyMinutes: row.medianReadyMinutes,
    defaultTurnaroundMinutes: row.defaultTurnaroundMinutes,
    fromPrice: fromPrices.get(row.id) ?? null,
    capabilities: capabilities.get(row.id) ?? NO_CAPABILITIES,
    hours: hours.get(row.id) ?? [[], [], [], [], [], [], []],
    pausedUntil: row.pausedUntil?.toISOString() ?? null,
    pauseReason: row.pauseReason,
    latitude: row.latitude,
    longitude: row.longitude,
    photoKey: null,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
  }))

  // "Open now" and the turnaround filter depend on shop hours, which arrive in the
  // batched query — so they are applied here, by the same code the dev source uses.
  const filtered = applyFilters(summaries, query.filters, now)
  const sorted = sortShops(filtered, query.sort, now)
  const page = sorted.slice(offset, offset + limit)

  return {
    shops: page,
    nextCursor: offset + limit < sorted.length ? encodeCursor(offset + limit) : null,
    radiusMetresUsed: query.origin ? radius : null,
    widened,
  }
}

async function selectShops(db: DbHandle, query: DiscoveryQuery, radiusMetres: number) {
  const origin = query.origin
  const distance = origin
    ? sql<number>`ST_Distance(${shops.location}, ${pointOf(origin)})`
    : sql<number | null>`NULL::double precision`

  const conditions = [eq(shops.discoverable, true)]

  if (origin) {
    conditions.push(sql`ST_DWithin(${shops.location}, ${pointOf(origin)}, ${radiusMetres})`)
  }
  if (query.cityId) conditions.push(eq(shops.cityId, query.cityId))
  if (query.pincode) conditions.push(eq(shops.pincode, query.pincode))

  const q = query.filters?.q?.trim()
  if (q) {
    const pattern = `%${q.replace(/[%_\\]/g, (match) => `\\${match}`)}%`
    conditions.push(
      or(
        sql`${shops.name} ILIKE ${pattern}`,
        sql`${shops.tagline} ILIKE ${pattern}`,
        sql`${localities.name} ILIKE ${pattern}`,
      )!,
    )
  }

  // Capability filters that SQL can do cheaply, so fewer rows come back at all.
  const filters = query.filters
  if (filters?.colour) conditions.push(eq(shopCapabilities.supportsColour, true))
  if (filters?.duplex) conditions.push(eq(shopCapabilities.supportsDuplex, true))
  if (filters?.scanning) conditions.push(eq(shopCapabilities.supportsScanning, true))
  if (filters?.largeFormat) conditions.push(eq(shopCapabilities.supportsLargeFormat, true))
  if (filters?.paperSize) {
    conditions.push(sql`${shopCapabilities.paperSizes} @> ARRAY[${filters.paperSize}]::text[]`)
  }
  if (filters?.finishing) {
    conditions.push(sql`${shopCapabilities.finishings} @> ARRAY[${filters.finishing}]::text[]`)
  }

  return db
    .select({
      ...shopColumns,
      distanceMetres: distance,
      latitude: sql<number | null>`ST_Y(${shops.location}::geometry)`,
      longitude: sql<number | null>`ST_X(${shops.location}::geometry)`,
    })
    .from(shops)
    .leftJoin(localities, eq(localities.id, shops.localityId))
    .leftJoin(cities, eq(cities.id, shops.cityId))
    .leftJoin(shopCapabilities, eq(shopCapabilities.shopId, shops.id))
    .where(and(...conditions))
    // A hard cap: the page is sliced in TypeScript after hours-dependent filtering, so
    // this bounds the work rather than defining the page.
    .limit(200)
    .orderBy(origin ? asc(distance) : desc(shops.ordersCompleted))
}

// ── One shop ────────────────────────────────────────────────────────────────

export async function getShopFromDatabase(
  idOrSlug: string,
  origin?: { latitude: number; longitude: number },
): Promise<ShopDetail | null> {
  const db = getDb()
  // A uuid or a slug, without asking the caller which — links use slugs, the app uses
  // ids, and both must resolve.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug)

  const distance = origin
    ? sql<number>`ST_Distance(${shops.location}, ${pointOf(origin)})`
    : sql<number | null>`NULL::double precision`

  const rows = await db
    .select({
      ...shopColumns,
      distanceMetres: distance,
      latitude: sql<number | null>`ST_Y(${shops.location}::geometry)`,
      longitude: sql<number | null>`ST_X(${shops.location}::geometry)`,
    })
    .from(shops)
    .leftJoin(localities, eq(localities.id, shops.localityId))
    .leftJoin(cities, eq(cities.id, shops.cityId))
    .where(and(eq(shops.discoverable, true), isUuid ? eq(shops.id, idOrSlug) : eq(shops.slug, idOrSlug)))
    .limit(1)

  const row = rows[0]
  if (!row) return null

  const [hours, capabilities, fromPrices, priceList, reviews, closures] = await Promise.all([
    hoursFor(db, [row.id]),
    capabilitiesFor(db, [row.id]),
    fromPricesFor(db, [row.id]),
    priceListFor(db, row.id),
    reviewsFor(db, row.id),
    closuresFor(db, row.id),
  ])

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    about: row.about,
    localityName: row.localityName,
    cityName: row.cityName,
    distanceMetres: row.distanceMetres === null ? null : Math.round(row.distanceMetres),
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    landmark: row.landmark,
    pincode: row.pincode,
    latitude: row.latitude,
    longitude: row.longitude,
    // The masked number is only sent when the shop chose to publish it.
    contactPhoneMasked: row.showPhoneToCustomer ? row.contactPhoneMasked : null,
    ratingAvgCenti: row.ratingAvgCenti,
    ratingCount: row.ratingCount,
    ordersCompleted: row.ordersCompleted,
    medianReadyMinutes: row.medianReadyMinutes,
    defaultTurnaroundMinutes: row.defaultTurnaroundMinutes,
    acceptWindowMinutes: row.acceptWindowMinutes,
    pickupGraceHours: row.pickupGraceHours,
    minOrderValuePaise: row.minOrderValuePaise.toString(),
    maxPagesPerOrder: row.maxPagesPerOrder,
    maxFilesPerOrder: row.maxFilesPerOrder,
    fromPrice: fromPrices.get(row.id) ?? null,
    capabilities: capabilities.get(row.id) ?? NO_CAPABILITIES,
    hours: hours.get(row.id) ?? [[], [], [], [], [], [], []],
    pausedUntil: row.pausedUntil?.toISOString() ?? null,
    pauseReason: row.pauseReason,
    photoKey: null,
    photoKeys: [],
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    priceList,
    recentReviews: reviews,
    closures,
  }
}

/**
 * The published price list, grouped by service kind.
 *
 * Grouped by `kind` rather than by category id so the headings read the way a customer
 * thinks — printing, then finishing, then scanning — regardless of how an admin has
 * arranged the catalogue's categories.
 */
async function priceListFor(db: DbHandle, shopId: string): Promise<ShopPriceGroup[]> {
  const rows = await db
    .select({
      code: serviceItems.code,
      name: serviceItems.name,
      shortName: serviceItems.shortName,
      kind: serviceItems.kind,
      paperSizeCode: serviceItems.paperSizeCode,
      colourMode: serviceItems.colourMode,
      sides: serviceItems.sides,
      priceUnit: serviceItems.priceUnit,
      sortOrder: serviceItems.sortOrder,
      bandMin: priceBands.minQuantity,
      bandMax: priceBands.maxQuantity,
      bandPrice: priceBands.unitPricePaise,
    })
    .from(shopServiceItems)
    .innerJoin(serviceItems, eq(serviceItems.id, shopServiceItems.serviceItemId))
    .leftJoin(priceBands, eq(priceBands.shopServiceItemId, shopServiceItems.id))
    .where(
      and(
        eq(shopServiceItems.shopId, shopId),
        eq(shopServiceItems.isAvailable, true),
        eq(serviceItems.isActive, true),
      ),
    )
    .orderBy(asc(serviceItems.sortOrder), asc(serviceItems.code), asc(priceBands.minQuantity))

  const headings: Record<string, string> = {
    print: 'Printing',
    finishing: 'Binding & finishing',
    scan: 'Scanning',
    handling: 'Other charges',
  }
  const unitNames: Record<string, string> = {
    per_page: 'page',
    per_sheet: 'sheet',
    per_copy: 'copy',
    per_order: 'order',
    per_sqft: 'sq ft',
  }

  const groups = new Map<string, ShopPriceGroup>()
  const items = new Map<string, ShopPriceGroup['items'][number]>()

  for (const row of rows) {
    const heading = headings[row.kind] ?? 'Other charges'
    let group = groups.get(heading)
    if (!group) {
      group = { heading, items: [] }
      groups.set(heading, group)
    }

    let item = items.get(row.code)
    if (!item) {
      const qualifier = [
        row.paperSizeCode?.toUpperCase(),
        row.sides === 'double' ? 'both sides' : row.sides === 'single' ? 'one side' : null,
      ]
        .filter(Boolean)
        .join(' · ')
      item = {
        code: row.code,
        label: row.shortName ?? row.name,
        qualifier: qualifier || null,
        // Overwritten by the first band below; a priced item always has one.
        pricePaise: '0',
        unit: unitNames[row.priceUnit] ?? 'unit',
        tiers: [],
      }
      items.set(row.code, item)
      group.items.push(item)
    }

    if (row.bandPrice !== null && row.bandMin !== null) {
      item.tiers.push({
        fromQuantity: row.bandMin,
        toQuantity: row.bandMax,
        pricePaise: row.bandPrice.toString(),
      })
    }
  }

  // The headline price for an item is its first band, and a single band is not a tier
  // list — a "1+ ₹2" table beside a "₹2/page" heading is noise.
  for (const item of items.values()) {
    const first = item.tiers[0]
    if (first) item.pricePaise = first.pricePaise
    if (item.tiers.length <= 1) item.tiers = []
  }

  const order = ['Printing', 'Binding & finishing', 'Scanning', 'Other charges']
  return [...groups.values()].sort(
    (a, b) => order.indexOf(a.heading) - order.indexOf(b.heading),
  )
}

/**
 * Recent public ratings.
 *
 * `authorLabel` is built here and the full name never leaves the server: "Aditi M." is
 * enough social proof, and a full name beside a locality is identifying.
 *
 * `comment` and `shop_reply` are **not selected**. Review text is V1 (FR-803/804) and
 * needs moderation before publication; not reading the columns means an MVP screen
 * cannot render unmoderated customer prose even if someone adds a field to the view.
 */
async function reviewsFor(db: DbHandle, shopId: string): Promise<ShopReview[]> {
  const rows = await db
    .select({
      id: orderRatings.id,
      stars: orderRatings.stars,
      createdAt: orderRatings.createdAt,
      fullName: users.fullName,
    })
    .from(orderRatings)
    .leftJoin(users, eq(users.id, orderRatings.userId))
    .where(
      and(
        eq(orderRatings.shopId, shopId),
        eq(orderRatings.isPublic, true),
        eq(orderRatings.moderationState, 'published'),
      ),
    )
    .orderBy(desc(orderRatings.createdAt))
    .limit(8)

  return rows.map((row) => ({
    id: row.id,
    authorLabel: initialise(row.fullName),
    stars: row.stars,
    createdAt: row.createdAt.toISOString(),
  }))
}

function initialise(fullName: string | null): string {
  if (!fullName) return 'Chaapo customer'
  const parts = fullName.trim().split(/\s+/)
  const first = parts[0] ?? 'Chaapo customer'
  const surname = parts.length > 1 ? parts[parts.length - 1] : undefined
  return surname ? `${first} ${surname.charAt(0).toUpperCase()}.` : first
}

/** Upcoming closures the shop chose to publish, for the next two months. */
async function closuresFor(db: DbHandle, shopId: string) {
  const horizon = new Date(Date.now() + 60 * 86_400_000)
  const rows = await db
    .select({
      startsAt: shopClosures.startsAt,
      endsAt: shopClosures.endsAt,
      reason: shopClosures.reason,
      reasonPublic: shopClosures.reasonPublic,
    })
    .from(shopClosures)
    .where(
      and(
        eq(shopClosures.shopId, shopId),
        gte(shopClosures.endsAt, new Date()),
        lte(shopClosures.startsAt, horizon),
      ),
    )
    .orderBy(asc(shopClosures.startsAt))
    .limit(6)

  return rows.map((row) => ({
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    reason: row.reasonPublic ? row.reason : null,
  }))
}
