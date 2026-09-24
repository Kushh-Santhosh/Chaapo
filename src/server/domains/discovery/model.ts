/**
 * Discovery read model.
 *
 * These types are the contract between the shops domain and every surface that
 * renders a shop. Three properties are deliberate and load-bearing:
 *
 * 1. **Serialisable.** Money is a decimal string of paise, timestamps are ISO strings.
 *    A React Server Component may hand any of this straight to a client island
 *    without a mapping step, and the same objects are what `/api/v1/shops` returns.
 * 2. **Already filtered.** Nothing in this model can express an undiscoverable shop.
 *    `shops.discoverable` is a generated column (status live + verification verified +
 *    a location + not deleted + not suspended), and the query filters on it, so
 *    "unverified shops must never appear in discovery" is enforced one level below
 *    anything a screen can get wrong.
 * 3. **No PII, no keys.** A shop's contact number is only present when the shop has
 *    opted into showing it, and photos are object *keys* — the UI resolves them
 *    through the signed-URL proxy, because there are no public file URLs in this
 *    system.
 */

import type { WeeklyHours } from '../../../lib/time'

/** What a shop's machines can do. Discovery filters on this before it filters price. */
export interface ShopCapabilitySummary {
  paperSizes: string[]
  colour: boolean
  bw: boolean
  duplex: boolean
  /** Finishing codes: 'staple' | 'spiral' | 'soft_bind' | 'lamination' | … */
  finishings: string[]
  cardStock: boolean
  photoPaper: boolean
  largeFormat: boolean
  scanning: boolean
  printerCount: number
}

/** The indicative headline rate on a card. Never the price of an order. */
export interface ShopFromPrice {
  /** Paise, as a decimal string. */
  pricePaise: string
  /** 'page' | 'sheet' | 'copy' — what the rate is per. */
  unit: string
  /** 'B&W A4', 'Colour A4' — what the rate is *for*. */
  label: string
}

export interface ShopSummary {
  id: string
  slug: string
  name: string
  tagline: string | null

  localityName: string | null
  cityName: string | null
  /**
   * Straight-line metres from the search origin, or `null` when the search had no
   * origin (a pincode or city search rather than a located one). Straight-line and
   * not road distance on purpose: it is honest about being an estimate, and it costs
   * one PostGIS operator instead of a routing call per shop.
   */
  distanceMetres: number | null

  /** Rating × 100. 431 = 4.31. `null` until the shop has enough ratings to show. */
  ratingAvgCenti: number | null
  ratingCount: number
  ordersCompleted: number
  /** Observed median, which is what to show when we have one. */
  medianReadyMinutes: number | null
  /** The shop's own promise, which is what to show before we have observations. */
  defaultTurnaroundMinutes: number

  fromPrice: ShopFromPrice | null
  capabilities: ShopCapabilitySummary
  /** Index 0 = Sunday. Used to render open/closed live on the client. */
  hours: WeeklyHours
  /** ISO instant the shop paused until, if it is taking a break (FR-206). */
  pausedUntil: string | null
  pauseReason: string | null

  /** Public coordinates for map display. These are intentionally included with the summary
   * because map browsing is a public shop-discovery surface, not a private profile leak.
   */
  latitude: number | null
  longitude: number | null
  /** Object key in the private assets bucket, resolved through the image proxy. */
  photoKey: string | null
  verifiedAt: string | null
}

/** Everything a shop profile page shows that a card does not. */
export interface ShopDetail extends ShopSummary {
  about: string | null
  addressLine1: string
  addressLine2: string | null
  landmark: string | null
  pincode: string | null
  /** Rounded to ~100 m for display; exact enough to open a map, not to doorstep. */
  latitude: number | null
  longitude: number | null
  /** Present only when the shop opted in (`show_phone_to_customer`). */
  contactPhoneMasked: string | null

  acceptWindowMinutes: number
  pickupGraceHours: number
  /** Paise as a string. Below this the checkout refuses, so it must be visible. */
  minOrderValuePaise: string
  maxPagesPerOrder: number | null
  maxFilesPerOrder: number | null

  /** Published price list, grouped for display. */
  priceList: ShopPriceGroup[]
  photoKeys: string[]
  recentReviews: ShopReview[]
  /** Upcoming closures the shop chose to publish. */
  closures: ShopClosureSummary[]
}

export interface ShopPriceGroup {
  /** 'Printing' | 'Binding & finishing' | 'Scanning' */
  heading: string
  items: ShopPriceItem[]
}

export interface ShopPriceItem {
  code: string
  label: string
  /** 'A4 · one side' — the qualifier that makes the rate unambiguous. */
  qualifier: string | null
  pricePaise: string
  unit: string
  /** Tiered rates: "1–50 pages ₹3, 51+ ₹2". Empty when the rate is flat. */
  tiers: ShopPriceTier[]
}

export interface ShopPriceTier {
  fromQuantity: number
  toQuantity: number | null
  pricePaise: string
}

/**
 * One published rating.
 *
 * Stars, author label and date — and deliberately nothing else. Review *text* and shop
 * replies are V1 (PRD C-06 "(V1 text)", C-18, FR-803/804): they need moderation, an
 * appeal path and a reply flow before a single sentence can be shown to the public, and
 * none of that is in MVP. `order_ratings` reserves the columns; this read model does not
 * carry them, so no screen can render them by accident.
 */
export interface ShopReview {
  id: string
  /** First name plus an initial. Never a full name, never a phone number. */
  authorLabel: string
  stars: number
  createdAt: string
}

export interface ShopClosureSummary {
  startsAt: string
  endsAt: string
  /** `null` when the shop chose not to publish the reason. */
  reason: string | null
}

// ── Query ───────────────────────────────────────────────────────────────────

export type DiscoverySort = 'nearest' | 'fastest' | 'cheapest' | 'rating'

/** A capability filter. Every field is optional; absent means "do not filter". */
export interface DiscoveryFilters {
  /** Free text over shop name, locality and tagline. */
  q?: string
  colour?: boolean
  duplex?: boolean
  paperSize?: string
  finishing?: string
  scanning?: boolean
  largeFormat?: boolean
  /** Only shops open at the time of the search. */
  openNow?: boolean
  /** Ready within this many minutes, by the shop's own promise. */
  maxTurnaroundMinutes?: number
}

export interface DiscoveryOrigin {
  latitude: number
  longitude: number
  /**
   * Metres. Optional because most callers do not have an opinion: the service
   * applies `DEFAULT_RADIUS_METRES` and widens from there when a narrow radius
   * finds nothing.
   */
  radiusMetres?: number
}

export interface DiscoveryQuery {
  /** Absent when the customer has not granted location and searched by text. */
  origin?: DiscoveryOrigin
  cityId?: string
  pincode?: string
  filters?: DiscoveryFilters
  sort?: DiscoverySort
  limit?: number
  /** Opaque cursor from a previous page. */
  cursor?: string
}

export interface DiscoveryResult {
  shops: ShopSummary[]
  /** `null` when this is the last page. */
  nextCursor: string | null
  /**
   * The radius actually used, which may be wider than requested: a customer in a
   * thin area gets results rather than an empty state, and the UI says so.
   */
  radiusMetresUsed: number | null
  /** True when the service widened the radius to find anything at all. */
  widened: boolean
}

export const DEFAULT_RADIUS_METRES = 3_000
export const MAX_RADIUS_METRES = 25_000
export const DEFAULT_PAGE_SIZE = 20

/** Rating × 100 → '4.3'. Below three ratings we show nothing, not a lonely 5.0. */
export const MIN_RATINGS_TO_DISPLAY = 3

export function formatRating(ratingAvgCenti: number | null, ratingCount: number): string | null {
  if (ratingAvgCenti === null || ratingCount < MIN_RATINGS_TO_DISPLAY) return null
  return (ratingAvgCenti / 100).toFixed(1)
}

/** '1.2 km' / '450 m'. Under a kilometre stays in metres, rounded to 50. */
export function formatDistance(metres: number | null): string | null {
  if (metres === null) return null
  if (metres < 1000) return `${Math.round(metres / 50) * 50} m`
  return `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0)} km`
}

/** 'about 25 min' / 'about 1 hr 30 min' — the turnaround promise, in words. */
export function formatTurnaround(minutes: number): string {
  if (minutes < 60) return `about ${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (rest === 0) return `about ${hours} hr`
  return `about ${hours} hr ${rest} min`
}
