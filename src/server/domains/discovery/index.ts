/**
 * Discovery — the public read side of the marketplace.
 *
 * The only entry point screens and routes should import from. `repo.ts` is deliberately
 * *not* re-exported: it pulls in the Postgres driver, and `service.ts` reaches it with a
 * dynamic import so the dev-fixture path never loads `pg`. Re-exporting it here would
 * undo that in one line.
 */

export {
  DEFAULT_PAGE_SIZE,
  DEFAULT_RADIUS_METRES,
  MAX_RADIUS_METRES,
  MIN_RATINGS_TO_DISPLAY,
  formatDistance,
  formatRating,
  formatTurnaround,
  type DiscoveryFilters,
  type DiscoveryOrigin,
  type DiscoveryQuery,
  type DiscoveryResult,
  type DiscoverySort,
  type ShopCapabilitySummary,
  type ShopClosureSummary,
  type ShopDetail,
  type ShopFromPrice,
  type ShopPriceGroup,
  type ShopPriceItem,
  type ShopPriceTier,
  type ShopReview,
  type ShopSummary,
} from './model'

export {
  applyFilters,
  availabilityOf,
  decodeCursor,
  effectiveTurnaroundMinutes,
  encodeCursor,
  getShop,
  isPaused,
  searchShops,
  sortShops,
} from './service'

export { MissingDatabaseError, discoverySource, usingDevFixtures, type DiscoverySource } from './source'
export { registerDevShop, listRegisteredDevShops, type RegisterShopInput } from './registered-store'
