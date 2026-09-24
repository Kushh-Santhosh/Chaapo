/**
 * Catalogue and pricing — mirrors `db/migrations/0004_catalogue.sql`.
 *
 * Three layers, deliberately separated:
 *   1. platform catalogue (`paperSizes`, `serviceCategories`, `serviceItems`)
 *   2. a shop's offering (`shopServiceItems`)
 *   3. quantity bands (`priceBands`) — the only place per-unit print money lives
 *
 * Every amount here is the *list* price. What a customer pays is snapshotted onto
 * the order at placement and never read back from these tables (PRD §F inv. 6).
 */

import { boolean, integer, jsonb, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core'

import { citext, createdAt, id, paise, timestamps, tstz } from '../columns'
import { userRoleEnum } from './enums'
import { users } from './identity'
import { shops } from './shops'

/**
 * A reference table rather than an enum: shops in different cities stock different
 * sizes (legal, FS, 12×18 art card) and admins add them without a deploy.
 */
export const paperSizes = pgTable('paper_sizes', {
  code: citext('code').primaryKey(),
  name: text('name').notNull(),
  widthMm: integer('width_mm').notNull(),
  heightMm: integer('height_mm').notNull(),
  /** Sheets of this size per standard A4 sheet, ×100. A4 = 100, A3 = 200. */
  sheetFactorCenti: integer('sheet_factor_centi').notNull().default(100),
  isLargeFormat: boolean('is_large_format').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(100),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
})

export const serviceCategories = pgTable('service_categories', {
  id: id(),
  code: citext('code').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  /** Lucide icon name, so the customer app ships no mapping table. */
  icon: text('icon'),
  sortOrder: integer('sort_order').notNull().default(100),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
})

/**
 * The platform catalogue. Because every shop prices the *same* item codes,
 * discovery can compare prices with a join instead of guessing at free-text service
 * names, and a customer's configuration is portable between shops (FR-104, FR-303).
 */
export const serviceItems = pgTable('service_items', {
  id: id(),
  categoryId: uuid('category_id')
    .notNull()
    .references(() => serviceCategories.id),
  code: citext('code').notNull(),
  name: text('name').notNull(),
  /** 'A4 B&W' — for chips and dense tables. */
  shortName: text('short_name'),
  description: text('description'),

  /** The pricing engine dispatches on this. */
  kind: text('kind').$type<'print' | 'finishing' | 'scan' | 'handling'>().notNull(),

  /** Print attributes — present when kind = 'print', NULL otherwise. */
  paperSizeCode: citext('paper_size_code').references(() => paperSizes.code),
  colourMode: text('colour_mode').$type<'bw' | 'colour'>(),
  sides: text('sides').$type<'single' | 'double'>(),

  /**
   * Which quantity the engine multiplies. `per_page` counts page images;
   * `per_sheet` counts physical sheets — duplex halves sheets, not pages.
   */
  priceUnit: text('price_unit')
    .$type<'per_page' | 'per_sheet' | 'per_copy' | 'per_order' | 'per_sqft'>()
    .notNull(),

  /** Finishing attributes. Empty array means "any paper size". */
  appliesToPaperSizes: citext('applies_to_paper_sizes').array().notNull().default([]),
  /** Physical bounds — a spiral binding cannot take 900 pages. */
  minPages: integer('min_pages'),
  maxPages: integer('max_pages'),

  /**
   * False routes the job to the quote flow instead of guessing at a price
   * (FR-306). This is the mechanism behind "quote-required" work.
   */
  autoPriceable: boolean('auto_priceable').notNull().default(true),

  /** Baseline turnaround contribution, so a new shop's estimates are sane on day one. */
  setupMinutes: integer('setup_minutes').notNull().default(0),
  minutesPer100Units: integer('minutes_per_100_units').notNull().default(0),

  sortOrder: integer('sort_order').notNull().default(100),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
})

/**
 * A shop's price and availability for a platform item. A shop that does not offer
 * an item simply has no row.
 */
export const shopServiceItems = pgTable('shop_service_items', {
  id: id(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  serviceItemId: uuid('service_item_id')
    .notNull()
    .references(() => serviceItems.id, { onDelete: 'cascade' }),

  isAvailable: boolean('is_available').notNull().default(true),
  /** Temporarily out (paper ran out, laminator broken) — distinct from isAvailable. */
  unavailableUntil: tstz('unavailable_until'),
  unavailableReason: text('unavailable_reason'),

  /** Flat charge added once when this item appears on an order. */
  setupFeePaise: paise('setup_fee_paise').notNull().default(0n),
  /** Order-level floor for this item: a 2-page job still costs at least this. */
  minChargePaise: paise('min_charge_paise').notNull().default(0n),

  minQuantity: integer('min_quantity').notNull().default(1),
  maxQuantity: integer('max_quantity'),

  /** Turnaround overrides. NULL falls back to the catalogue item. */
  setupMinutes: integer('setup_minutes'),
  minutesPer100Units: integer('minutes_per_100_units'),

  /** Force the quote flow at this shop regardless of the catalogue default. */
  requiresQuote: boolean('requires_quote').notNull().default(false),
  quoteAboveQuantity: integer('quote_above_quantity'),

  /** Shown to the customer on the configure screen. */
  notes: text('notes'),
  ...timestamps,
})

/**
 * Bulk tiers on a shop's item: 1–50 pages at ₹2, 51–200 at ₹1.60, 201+ at ₹1.20.
 * `maxQuantity` NULL means "and above". Exactly one band must match any quantity —
 * the domain layer validates coverage and contiguity on save, and the pricing engine
 * treats a missing band as an error rather than falling back to zero (PRD §35.3).
 */
export const priceBands = pgTable('price_bands', {
  id: id(),
  shopServiceItemId: uuid('shop_service_item_id')
    .notNull()
    .references(() => shopServiceItems.id, { onDelete: 'cascade' }),
  minQuantity: integer('min_quantity').notNull(),
  maxQuantity: integer('max_quantity'),
  unitPricePaise: paise('unit_price_paise').notNull(),
  /** Optional label on the price breakdown: "Bulk (200+)". */
  label: text('label'),
  ...timestamps,
})

/**
 * Which finishings a shop will apply to which print sizes. A shop may spiral-bind
 * A4 but not A3; absence of a row means "not offered", so the configure screen only
 * shows achievable combinations (FR-304).
 */
export const shopFinishingCompatibility = pgTable('shop_finishing_compatibility', {
  id: id(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  finishingItemId: uuid('finishing_item_id')
    .notNull()
    .references(() => serviceItems.id, { onDelete: 'cascade' }),
  paperSizeCode: citext('paper_size_code')
    .notNull()
    .references(() => paperSizes.code),
  maxPages: integer('max_pages'),
  ...createdAt,
})

/**
 * Rush surcharges and shop-run discounts, kept as data so an owner can run
 * "10% off before 10 am" without a deploy. Applied by the pricing engine in a fixed
 * order and itemised on the quote, never folded silently into the total (PRD §35.6).
 */
export const shopPriceModifiers = pgTable('shop_price_modifiers', {
  id: id(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  code: citext('code').notNull(),
  /** Shown on the customer's breakdown. */
  label: text('label').notNull(),
  kind: text('kind').$type<'surcharge' | 'discount'>().notNull(),

  /** Exactly one of these two is set. */
  rateBps: integer('rate_bps'),
  flatPaise: paise('flat_paise'),

  scope: text('scope').$type<'order' | 'item'>().notNull().default('order'),
  serviceItemId: uuid('service_item_id').references(() => serviceItems.id, {
    onDelete: 'cascade',
  }),

  minOrderPaise: paise('min_order_paise'),
  minQuantity: integer('min_quantity'),

  /** IST minutes from midnight, plus the weekdays it applies on. */
  activeFromMinute: integer('active_from_minute'),
  activeToMinute: integer('active_to_minute'),
  activeWeekdays: smallint('active_weekdays').array().notNull().default([0, 1, 2, 3, 4, 5, 6]),
  startsAt: tstz('starts_at'),
  endsAt: tstz('ends_at'),

  /** Cap on how much a percentage discount can take off. */
  maxDiscountPaise: paise('max_discount_paise'),
  priority: integer('priority').notNull().default(100),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
  ...timestamps,
})

/**
 * Append-only price-list history. "The price went up between me looking and me
 * paying" is answered from this table, and an admin investigating a shop that
 * doubles prices at 6 pm can see it (PRD §35.8, NFR-16).
 */
export const shopPriceHistory = pgTable('shop_price_history', {
  id: id(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  serviceItemId: uuid('service_item_id').references(() => serviceItems.id, {
    onDelete: 'set null',
  }),
  change: text('change')
    .$type<
      | 'item_added'
      | 'item_removed'
      | 'item_updated'
      | 'bands_updated'
      | 'availability_changed'
      | 'modifier_added'
      | 'modifier_updated'
      | 'modifier_removed'
      | 'bulk_import'
    >()
    .notNull(),
  /** Full before/after of the affected shop_service_item and its bands. */
  before: jsonb('before').$type<Record<string, unknown>>(),
  after: jsonb('after').$type<Record<string, unknown>>(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  actorRole: userRoleEnum('actor_role'),
  ...createdAt,
})
