/**
 * Reference geography — mirrors the cities and localities section of
 * `db/migrations/0003_geography_and_shops.sql`.
 *
 * Seeded in migration 0011 and extended by admins. Nothing here is user-generated,
 * which is why `slug` is safe to use in URLs.
 */

import { boolean, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core'

import { citext, geographyPoint, id, timestamps } from '../columns'

/**
 * A city Chaapo does or could operate in. `isLive` is the launch switch: an
 * unlaunched city exists so we can collect waitlist interest without showing an
 * empty discovery screen (FR-108).
 */
export const cities = pgTable('cities', {
  id: id(),
  slug: citext('slug').notNull(),
  name: text('name').notNull(),
  state: text('state').notNull(),
  /** City centre — the map default when the device gives us no location. */
  centre: geographyPoint('centre').notNull(),
  radiusM: integer('radius_m').notNull().default(25000),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  isLive: boolean('is_live').notNull().default(false),
  ...timestamps,
})

/** A neighbourhood within a city — "shops in Kothrud". Centre is optional. */
export const localities = pgTable('localities', {
  id: id(),
  cityId: uuid('city_id')
    .notNull()
    .references(() => cities.id, { onDelete: 'cascade' }),
  slug: citext('slug').notNull(),
  name: text('name').notNull(),
  centre: geographyPoint('centre'),
  pincodes: text('pincodes').array().notNull().default([]),
  ...timestamps,
})
