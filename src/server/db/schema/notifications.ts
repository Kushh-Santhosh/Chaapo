/**
 * Notifications — mirrors `db/migrations/0008_notifications.sql`.
 *
 * Three layers, in this order:
 *
 *   notificationTemplates → notifications → notificationDeliveries
 *
 * A message is rendered from a template, never assembled at the call site, so every
 * word a customer receives is reviewable and translatable and cannot accidentally
 * interpolate a file name or a pickup code into an SMS (PRD §46, §57.3). Deliveries
 * are split out per channel per attempt, so "push failed, WhatsApp covered it" is a
 * fact in the database rather than an inference (FR-601…FR-618).
 */

import { boolean, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core'

import { citext, createdAt, id, paise, timestamps, tstz } from '../columns'
import { notificationChannelEnum, notificationStateEnum } from './enums'
import { pushSubscriptions, users } from './identity'
import { payouts } from './money'
import { orders } from './orders'
import { shops } from './shops'

/** The same event reads differently to a customer and to a shop. */
export type NotificationAudience = 'customer' | 'shop' | 'admin'
export type NotificationPriority = 'critical' | 'high' | 'normal' | 'low'
/** Locales the copy registry accepts. Adding one is a data change, not a deploy. */
export type NotificationLocale = 'en-IN' | 'hi-IN' | 'mr-IN' | 'ta-IN' | 'te-IN' | 'kn-IN' | 'bn-IN'

/**
 * One row per (key, channel, locale, audience). Versioned, so we can answer which
 * wording a particular customer was sent months later.
 */
export const notificationTemplates = pgTable('notification_templates', {
  id: id(),
  /** Stable event key: 'order.ready', 'order.accepted', 'payout.paid'. */
  key: citext('key').notNull(),
  channel: notificationChannelEnum('channel').notNull(),
  locale: text('locale').$type<NotificationLocale>().notNull().default('en-IN'),
  version: integer('version').notNull().default(1),
  audience: text('audience').$type<NotificationAudience>().notNull(),

  /** Channel-specific. Only the relevant fields are filled; CHECKs enforce which. */
  subject: text('subject'),
  title: text('title'),
  body: text('body').notNull(),
  /** Deep link path, e.g. '/orders/{{orderNumber}}'. */
  actionPath: text('action_path'),
  actionLabel: text('action_label'),
  /** WhatsApp only accepts pre-approved templates; this is the provider's name for it. */
  providerTemplateName: text('provider_template_name'),
  providerTemplateLang: text('provider_template_lang'),

  /** Declared variables, validated at render time so a gap is an error, not a blank. */
  variables: text('variables').array().notNull().default([]),

  /** Transactional messages ignore quiet hours and marketing opt-out (PRD §46.4). */
  isTransactional: boolean('is_transactional').notNull().default(true),
  /** Do not resend the same key to the same recipient inside this window. */
  dedupeWindowSeconds: integer('dedupe_window_seconds').notNull().default(0),
  priority: text('priority').$type<NotificationPriority>().notNull().default('normal'),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
})

/**
 * One row per (event, recipient). Also the in-app inbox, which is why `readAt` lives
 * here rather than on a delivery. Content is stored rendered and redacted — a pickup
 * code never appears in an outbound body.
 */
export const notifications = pgTable('notifications', {
  id: id(),
  templateKey: citext('template_key').notNull(),
  templateVersion: integer('template_version'),
  audience: text('audience').$type<NotificationAudience>().notNull(),
  recipientUserId: uuid('recipient_user_id').references(() => users.id, { onDelete: 'cascade' }),
  /** For shop-audience messages: which shop. May fan out to several staff. */
  shopId: uuid('shop_id').references(() => shops.id, { onDelete: 'cascade' }),

  orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
  payoutId: uuid('payout_id').references(() => payouts.id, { onDelete: 'set null' }),
  /** FK to disputes, added in migration 0009. */
  disputeId: uuid('dispute_id'),

  title: text('title'),
  body: text('body').notNull(),
  actionPath: text('action_path'),
  actionLabel: text('action_label'),
  /** The variables used, for debugging a bad render. PII-redacted on write. */
  renderContext: jsonb('render_context').$type<Record<string, unknown>>().notNull().default({}),

  state: notificationStateEnum('state').notNull().default('queued'),
  priority: text('priority').$type<NotificationPriority>().notNull().default('normal'),
  isTransactional: boolean('is_transactional').notNull().default(true),

  /** Resolved against the recipient's preferences at queue time, not at send time. */
  channels: notificationChannelEnum('channels').array().notNull().default([]),
  /** Set when we decided not to send at all — consent, quiet hours, dedupe, no channel. */
  suppressedAt: tstz('suppressed_at'),
  suppressionReason: text('suppression_reason'),

  /** e.g. 'order:<id>:ready'. Unique while non-null. */
  dedupeKey: text('dedupe_key'),
  /** Scheduled sends: a digest, a pickup reminder at T+24 h. */
  scheduledFor: tstz('scheduled_for'),

  readAt: tstz('read_at'),
  dismissedAt: tstz('dismissed_at'),
  ...timestamps,
})

/**
 * One row per channel per attempt. A retry appends a row rather than overwriting, so
 * a flapping provider is visible instead of averaged away.
 */
export const notificationDeliveries = pgTable('notification_deliveries', {
  id: id(),
  notificationId: uuid('notification_id')
    .notNull()
    .references(() => notifications.id, { onDelete: 'cascade' }),
  channel: notificationChannelEnum('channel').notNull(),
  attempt: integer('attempt').notNull().default(1),
  state: notificationStateEnum('state').notNull().default('queued'),

  provider: text('provider'),
  providerMessageId: text('provider_message_id'),
  /** Masked phone or hashed push endpoint — enough to support, not enough to leak. */
  destinationMasked: text('destination_masked'),
  pushSubscriptionId: uuid('push_subscription_id').references(() => pushSubscriptions.id, {
    onDelete: 'set null',
  }),

  /** WhatsApp and SMS are not free; this is how the bill is attributed (PRD §46.7). */
  costPaise: paise('cost_paise'),

  queuedAt: tstz('queued_at').notNull().defaultNow(),
  sentAt: tstz('sent_at'),
  deliveredAt: tstz('delivered_at'),
  failedAt: tstz('failed_at'),
  failureCode: text('failure_code'),
  failureMessage: text('failure_message'),
  /** A 410 from a push service is not worth retrying. This is how we know. */
  isPermanentFailure: boolean('is_permanent_failure').notNull().default(false),
  nextRetryAt: tstz('next_retry_at'),
  /** Provider callbacks — delivered and read receipts — land here. */
  providerStatus: text('provider_status'),
  providerUpdatedAt: tstz('provider_updated_at'),
  ...timestamps,
})

/**
 * Append-only log of every request we made to a notification provider. Separate from
 * deliveries because one delivery can involve several calls (send, then a status
 * poll), and because this is the table we read when a provider claims we never called
 * them. Request and response are redacted digests: shapes, not message contents.
 */
export const notificationProviderCalls = pgTable('notification_provider_calls', {
  id: id(),
  deliveryId: uuid('delivery_id').references(() => notificationDeliveries.id, {
    onDelete: 'set null',
  }),
  provider: text('provider').notNull(),
  channel: notificationChannelEnum('channel').notNull(),
  operation: text('operation')
    .$type<'send' | 'status' | 'template_sync' | 'subscribe' | 'unsubscribe'>()
    .notNull(),
  httpStatus: integer('http_status'),
  durationMs: integer('duration_ms'),
  requestDigest: jsonb('request_digest').$type<Record<string, unknown>>(),
  responseDigest: jsonb('response_digest').$type<Record<string, unknown>>(),
  errorCode: text('error_code'),
  correlationId: text('correlation_id'),
  ...createdAt,
})
