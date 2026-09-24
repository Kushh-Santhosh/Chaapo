/**
 * Discovery service — search, filter, sort, page.
 *
 * The filtering and sorting rules live here, once, and both data sources feed the same
 * rules. That is why `applyFilters`/`sortShops` operate on `ShopSummary` rather than on
 * rows: the SQL path narrows in the database for the things SQL is good at (the
 * generated `discoverable` flag, the PostGIS radius, capability array containment) and
 * this module owns the parts that must not differ between environments — how "open
 * now" is decided, what "fastest" means when a shop has no observed median yet, and
 * the fact that a shop paused for lunch still appears but is marked.
 *
 * A paused shop is *not* hidden. Hiding it would make a customer think their regular
 * shop had shut down; showing it with "back by 3 pm" is the truth and keeps them from
 * walking over.
 */

import { isOpenAt, nowUtc } from '../../../lib/time'

import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_RADIUS_METRES,
  MAX_RADIUS_METRES,
  MIN_RATINGS_TO_DISPLAY,
  type DiscoveryFilters,
  type DiscoveryQuery,
  type DiscoveryResult,
  type ShopDetail,
  type ShopSummary,
} from './model'
import { detailOf, findDevShop, haversineMetres, summaryOf, DEV_SHOPS } from './fixtures'
import { findRegisteredDevShop, listRegisteredDevShops } from './registered-store'
import { discoverySource } from './source'

// ── Predicates, shared by both sources ──────────────────────────────────────

/** Whether a shop is taking orders right now, ignoring its published hours. */
export function isPaused(shop: ShopSummary, now: Date): boolean {
  return shop.pausedUntil !== null && new Date(shop.pausedUntil).getTime() > now.getTime()
}

/**
 * What the badge on the card should say. Computed server-side for the first paint and
 * recomputed on the client every minute, from the same `hours` array.
 */
export function availabilityOf(
  shop: ShopSummary,
  now: Date,
): 'open' | 'paused' | 'closed' {
  if (isPaused(shop, now)) return 'paused'
  return isOpenAt(shop.hours, now) ? 'open' : 'closed'
}

/** The number "fastest" sorts on: observed median, else the shop's own promise. */
export function effectiveTurnaroundMinutes(shop: ShopSummary): number {
  return shop.medianReadyMinutes ?? shop.defaultTurnaroundMinutes
}

function matchesText(shop: ShopSummary, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  const haystack = [shop.name, shop.tagline, shop.localityName, shop.cityName]
    .filter((part): part is string => Boolean(part))
    .join(' ')
    .toLowerCase()
  return haystack.includes(needle)
}

export function applyFilters(
  shops: ShopSummary[],
  filters: DiscoveryFilters | undefined,
  now: Date,
): ShopSummary[] {
  if (!filters) return shops

  return shops.filter((shop) => {
    if (filters.q && !matchesText(shop, filters.q)) return false

    // Capability filters are hard: a shop that cannot print colour is not a colour
    // candidate at any price or distance (FR-104).
    if (filters.colour && !shop.capabilities.colour) return false
    if (filters.duplex && !shop.capabilities.duplex) return false
    if (filters.scanning && !shop.capabilities.scanning) return false
    if (filters.largeFormat && !shop.capabilities.largeFormat) return false
    if (filters.paperSize && !shop.capabilities.paperSizes.includes(filters.paperSize)) return false
    if (filters.finishing && !shop.capabilities.finishings.includes(filters.finishing)) return false

    if (filters.maxTurnaroundMinutes !== undefined) {
      if (effectiveTurnaroundMinutes(shop) > filters.maxTurnaroundMinutes) return false
    }

    // "Open now" excludes paused shops too — someone filtering for open shops wants a
    // counter they can walk to, and a shop on a lunch break is not that.
    if (filters.openNow && availabilityOf(shop, now) !== 'open') return false

    return true
  })
}

/**
 * Sort, with a stable tiebreak.
 *
 * Every comparator falls through to `ordersCompleted` and then `id`, so two shops that
 * tie do not swap places between two identical requests — pagination over an unstable
 * sort silently duplicates and drops rows.
 */
export function sortShops(shops: ShopSummary[], sort: DiscoveryQuery['sort'], now: Date): ShopSummary[] {
  const tiebreak = (a: ShopSummary, b: ShopSummary): number =>
    b.ordersCompleted - a.ordersCompleted || a.id.localeCompare(b.id)

  // Whatever the sort, a shop that cannot take an order right now goes below one that
  // can. Ranking a closed shop first because it is 40 m closer wastes a walk.
  const availabilityRank = (shop: ShopSummary): number => {
    const state = availabilityOf(shop, now)
    return state === 'open' ? 0 : state === 'paused' ? 1 : 2
  }

  const byDistance = (a: ShopSummary, b: ShopSummary): number => {
    if (a.distanceMetres === null && b.distanceMetres === null) return 0
    if (a.distanceMetres === null) return 1
    if (b.distanceMetres === null) return -1
    return a.distanceMetres - b.distanceMetres
  }

  const comparators: Record<NonNullable<DiscoveryQuery['sort']>, (a: ShopSummary, b: ShopSummary) => number> = {
    nearest: byDistance,
    fastest: (a, b) => effectiveTurnaroundMinutes(a) - effectiveTurnaroundMinutes(b),
    cheapest: (a, b) => {
      // A shop with no published rate sorts last rather than as free.
      const priceOf = (shop: ShopSummary): bigint =>
        shop.fromPrice ? BigInt(shop.fromPrice.pricePaise) : BigInt(Number.MAX_SAFE_INTEGER)
      const difference = priceOf(a) - priceOf(b)
      return difference === 0n ? 0 : difference < 0n ? -1 : 1
    },
    rating: (a, b) => {
      // Shops below the display threshold are not "0 stars" — they are unrated, and
      // they sort after every rated shop instead of at the bottom of the ratings.
      const ratingOf = (shop: ShopSummary): number =>
        shop.ratingCount >= MIN_RATINGS_TO_DISPLAY ? (shop.ratingAvgCenti ?? -1) : -1
      return ratingOf(b) - ratingOf(a)
    },
  }

  const compare = comparators[sort ?? 'nearest']

  return [...shops].sort(
    (a, b) => availabilityRank(a) - availabilityRank(b) || compare(a, b) || byDistance(a, b) || tiebreak(a, b),
  )
}

// ── Cursor ──────────────────────────────────────────────────────────────────

/**
 * Offset cursors, base64url encoded.
 *
 * Offsets are honest for this data: discovery pages are small, the sort is stable, and
 * a keyset cursor over "distance then rating then id" would need the sort key in the
 * token, which leaks the shop's exact coordinates to anyone who base64-decodes it.
 */
export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (parsed && typeof parsed === 'object' && 'o' in parsed) {
      const offset = Number((parsed as { o: unknown }).o)
      if (Number.isInteger(offset) && offset >= 0 && offset <= 10_000) return offset
    }
  } catch {
    // A malformed cursor is a first page, not a 500. Nobody can act on the error.
  }
  return 0
}

// ── Search ──────────────────────────────────────────────────────────────────

/**
 * Find discoverable shops.
 *
 * Radius widening is the one piece of behaviour worth calling out: a customer in a
 * thinly covered area gets results from further away rather than an empty screen, the
 * result says it widened, and the UI tells them. Doubling stops at
 * `MAX_RADIUS_METRES`, because "your nearest print shop is 40 km away" is an empty
 * state with extra steps.
 */
export async function searchShops(query: DiscoveryQuery = {}): Promise<DiscoveryResult> {
  const now = nowUtc()
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), 50)
  const offset = decodeCursor(query.cursor)

  if (discoverySource() === 'database') {
    // Imported lazily so the fixture path never loads `pg`, and so a laptop without a
    // database does not need the driver present to open the app.
    const { searchShopsInDatabase } = await import('./repo')
    return searchShopsInDatabase({ ...query, limit }, offset, now)
  }

  const requestedRadius = query.origin?.radiusMetres ?? DEFAULT_RADIUS_METRES
  let radius = requestedRadius
  let widened = false

  const candidates = (): ShopSummary[] => {
    const withDistance = [...DEV_SHOPS, ...listRegisteredDevShops()].map((shop) =>
      summaryOf(shop, query.origin ? haversineMetres(query.origin, shop) : null),
    )
    const inRadius = query.origin
      ? withDistance.filter((shop) => shop.distanceMetres !== null && shop.distanceMetres <= radius)
      : withDistance
    return applyFilters(inRadius, query.filters, now)
  }

  let matched = candidates()
  while (matched.length === 0 && query.origin && radius < MAX_RADIUS_METRES) {
    radius = Math.min(radius * 2, MAX_RADIUS_METRES)
    widened = true
    matched = candidates()
  }

  const sorted = sortShops(matched, query.sort, now)
  const page = sorted.slice(offset, offset + limit)

  return {
    shops: page,
    nextCursor: offset + limit < sorted.length ? encodeCursor(offset + limit) : null,
    radiusMetresUsed: query.origin ? radius : null,
    widened,
  }
}

/**
 * One shop's profile, by id or slug.
 *
 * `null` for "no such discoverable shop" rather than a thrown error, because the two
 * cases a customer can produce — a stale link and a shop that has since been
 * suspended — must render the same 404. Distinguishing them tells an outsider that a
 * given shop exists and has been suspended, which is nobody's business.
 */
export async function getShop(
  idOrSlug: string,
  origin?: { latitude: number; longitude: number },
): Promise<ShopDetail | null> {
  if (discoverySource() === 'database') {
    const { getShopFromDatabase } = await import('./repo')
    return getShopFromDatabase(idOrSlug, origin)
  }

  const shop = findDevShop(idOrSlug) ?? findRegisteredDevShop(idOrSlug)
  if (!shop) return null
  return detailOf(shop, origin ? haversineMetres(origin, shop) : null)
}
