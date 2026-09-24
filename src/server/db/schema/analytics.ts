/**
 * Analytics — mirrors the tail of `db/migrations/0009_trust_privacy_config.sql`.
 *
 * Deliberately thin: an event name, a subject, and a small property bag. No page-view
 * firehose, no third-party pixel, no PII. It exists to answer the funnel questions in
 * the PRD — discovery → upload → configure → pay → collect — and nothing else
 * (PRD §54). `anonIdHash` lets a funnel be reconstructed without identifying anyone.
 *
 * The two rollup tables exist because the shop dashboard's charts and the admin city
 * view must be row-range reads rather than scans over `orders` (NFR-04). Dates are IST
 * calendar dates: a shop's Tuesday is its own Tuesday, not UTC's.
 */

import { date, integer, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core'

import { createdAt, id, paise, tstz } from '../columns'
import { cities } from './geo'
import { users } from './identity'
import { orders } from './orders'
import { shops } from './shops'

/** Append-only, enforced by trigger. */
export const analyticsEvents = pgTable('analytics_events', {
  id: id(),
  event: text('event').notNull(),
  surface: text('surface').$type<'customer' | 'shop' | 'admin' | 'worker'>().notNull(),
  /** Hashed session identifier. Never a raw device or session id. */
  anonIdHash: text('anon_id_hash'),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  shopId: uuid('shop_id').references(() => shops.id, { onDelete: 'set null' }),
  orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
  cityId: uuid('city_id').references(() => cities.id, { onDelete: 'set null' }),
  properties: jsonb('properties').$type<Record<string, unknown>>().notNull().default({}),
  /** Client-reported timings, checked against the NFR budgets. */
  durationMs: integer('duration_ms'),
  occurredAt: tstz('occurred_at').notNull().defaultNow(),
  ...createdAt,
})

/** One row per shop per IST day. Recomputed by a worker; never authoritative. */
export const shopDailyStats = pgTable(
  'shop_daily_stats',
  {
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    /** IST calendar date, kept as a string so no timezone is implied on read. */
    statDate: date('stat_date', { mode: 'string' }).notNull(),

    ordersPlaced: integer('orders_placed').notNull().default(0),
    ordersAccepted: integer('orders_accepted').notNull().default(0),
    ordersRejected: integer('orders_rejected').notNull().default(0),
    ordersAutoCancelled: integer('orders_auto_cancelled').notNull().default(0),
    ordersCollected: integer('orders_collected').notNull().default(0),
    ordersCancelled: integer('orders_cancelled').notNull().default(0),
    pagesPrinted: integer('pages_printed').notNull().default(0),

    grossPaise: paise('gross_paise').notNull().default(0n),
    commissionPaise: paise('commission_paise').notNull().default(0n),
    refundedPaise: paise('refunded_paise').notNull().default(0n),
    netPaise: paise('net_paise').notNull().default(0n),

    medianAcceptSeconds: integer('median_accept_seconds'),
    medianReadyMinutes: integer('median_ready_minutes'),
    onTimeCount: integer('on_time_count').notNull().default(0),
    lateCount: integer('late_count').notNull().default(0),
    /** Sum and count, not an average: a mean of means is not a mean. */
    ratingSum: integer('rating_sum').notNull().default(0),
    ratingCount: integer('rating_count').notNull().default(0),
    computedAt: tstz('computed_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.shopId, t.statDate] })],
)

export const platformDailyStats = pgTable('platform_daily_stats', {
  statDate: date('stat_date', { mode: 'string' }).primaryKey(),
  cityId: uuid('city_id').references(() => cities.id, { onDelete: 'cascade' }),
  newCustomers: integer('new_customers').notNull().default(0),
  newShops: integer('new_shops').notNull().default(0),
  shopsLive: integer('shops_live').notNull().default(0),
  ordersPlaced: integer('orders_placed').notNull().default(0),
  ordersCollected: integer('orders_collected').notNull().default(0),
  gmvPaise: paise('gmv_paise').notNull().default(0n),
  revenuePaise: paise('revenue_paise').notNull().default(0n),
  refundedPaise: paise('refunded_paise').notNull().default(0n),
  disputesOpened: integer('disputes_opened').notNull().default(0),
  computedAt: tstz('computed_at').notNull().defaultNow(),
})
