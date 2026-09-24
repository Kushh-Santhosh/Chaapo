/**
 * Trust: audit, disputes and risk — mirrors the first half of
 * `db/migrations/0009_trust_privacy_config.sql`.
 *
 * `auditLogs` is append-only, enforced by trigger rather than by convention: a
 * compromised application credential cannot erase its own trail (NFR-16). Every
 * consequential action on every surface lands here with actor, target, before, after
 * and reason — it is a deliberate record, not a debug log.
 *
 * A dispute holds an order's money while it is open (PRD §43). A risk flag is our own
 * suspicion rather than a party's complaint, which is why the two are separate tables
 * with separate queues (PRD §51).
 */

import { boolean, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core'

import { createdAt, id, paise, timestamps, tstz } from '../columns'
import { disputeStateEnum, userRoleEnum } from './enums'
import { users } from './identity'
import { orders } from './orders'
import { shops } from './shops'

export type ActorType = 'customer' | 'shop' | 'admin' | 'system' | 'provider'

/**
 * Append-only audit trail.
 *
 * `actorLabel` and `targetLabel` are denormalised on purpose: the log must stay
 * readable after the user it names has exercised their right to erasure.
 */
export const auditLogs = pgTable('audit_logs', {
  id: id(),
  /** Dotted action name: 'shop.verification.approved', 'order.pickup.overridden'. */
  action: text('action').notNull(),
  category: text('category')
    .$type<
      | 'auth'
      | 'account'
      | 'shop'
      | 'verification'
      | 'catalogue'
      | 'order'
      | 'payment'
      | 'refund'
      | 'payout'
      | 'file'
      | 'privacy'
      | 'config'
      | 'notification'
      | 'dispute'
      | 'admin'
      | 'security'
    >()
    .notNull(),
  severity: text('severity')
    .$type<'info' | 'notice' | 'warning' | 'critical'>()
    .notNull()
    .default('info'),

  actorType: text('actor_type').$type<ActorType>().notNull(),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  actorRole: userRoleEnum('actor_role'),
  actorLabel: text('actor_label'),
  actorShopId: uuid('actor_shop_id').references(() => shops.id, { onDelete: 'set null' }),
  /** Both identities are recorded — impersonation is never anonymous (PRD §50.6). */
  impersonatedUserId: uuid('impersonated_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),

  targetType: text('target_type').notNull(),
  targetId: uuid('target_id'),
  targetLabel: text('target_label'),

  /** Only the fields that changed, PII-redacted. */
  before: jsonb('before').$type<Record<string, unknown>>(),
  after: jsonb('after').$type<Record<string, unknown>>(),
  /** Required for overrides and money movements; the domain layer decides which. */
  reason: text('reason'),
  /** Makes "every admin action above ₹5,000 last week" one indexed query. */
  amountPaise: paise('amount_paise'),

  correlationId: text('correlation_id'),
  ipHash: text('ip_hash'),
  userAgentFamily: text('user_agent_family'),
  ...createdAt,
})

/**
 * A disagreement between a customer and a shop, or something an admin spotted. While
 * one is open the order's funds do not settle.
 */
export const disputes = pgTable('disputes', {
  id: id(),
  reference: text('reference').notNull(),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'restrict' }),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'restrict' }),
  customerUserId: uuid('customer_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),

  state: disputeStateEnum('state').notNull().default('open'),
  raisedBy: text('raised_by').$type<'customer' | 'shop' | 'admin' | 'system'>().notNull(),
  raisedByUserId: uuid('raised_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  category: text('category')
    .$type<
      | 'print_quality'
      | 'wrong_output'
      | 'missing_pages'
      | 'not_ready'
      | 'never_collected'
      | 'overcharged'
      | 'file_privacy'
      | 'rude_service'
      | 'payment_not_received'
      | 'chargeback'
      | 'other'
    >()
    .notNull(),
  summary: text('summary').notNull(),
  /** What the customer wants: a refund, a reprint, or an explanation. */
  requestedRemedy: text('requested_remedy').$type<
    'refund_full' | 'refund_partial' | 'reprint' | 'explanation' | 'other'
  >(),
  amountPaise: paise('amount_paise').notNull(),

  assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
  assignedAt: tstz('assigned_at'),
  /** SLA for the support team. */
  respondBy: tstz('respond_by'),
  firstResponseAt: tstz('first_response_at'),

  resolution: text('resolution').$type<
    | 'refund_full'
    | 'refund_partial'
    | 'reprint_arranged'
    | 'no_action'
    | 'shop_at_fault'
    | 'customer_at_fault'
    | 'inconclusive'
    | 'withdrawn'
  >(),
  resolutionNote: text('resolution_note'),
  resolvedRefundPaise: paise('resolved_refund_paise'),
  costBorneBy: text('cost_borne_by').$type<'platform' | 'shop' | 'shared' | 'none'>(),
  resolvedAt: tstz('resolved_at'),
  resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
  /** Whether this counts against the shop's quality score. */
  countsAgainstShop: boolean('counts_against_shop').notNull().default(false),

  /** File ids and photo storage keys. No URLs. */
  evidence: jsonb('evidence').$type<Record<string, unknown>[]>().notNull().default([]),
  ...timestamps,
})

/**
 * The dispute conversation. Append-only — editing what you said in a dispute is not a
 * feature. `visibleTo` is explicit, so an internal admin note is never shown to
 * either party.
 */
export const disputeMessages = pgTable('dispute_messages', {
  id: id(),
  disputeId: uuid('dispute_id')
    .notNull()
    .references(() => disputes.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  authorType: text('author_type').$type<'customer' | 'shop' | 'admin' | 'system'>().notNull(),
  authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
  authorLabel: text('author_label'),
  body: text('body').notNull(),
  /** Storage keys in the private dispute bucket. No URLs. */
  attachmentKeys: text('attachment_keys').array().notNull().default([]),
  visibleTo: text('visible_to')
    .array()
    .$type<('customer' | 'shop' | 'admin')[]>()
    .notNull()
    .default(['customer', 'shop', 'admin']),
  ...createdAt,
})

/**
 * The trust queue. Raised by rules — a shop overriding pickup verification
 * repeatedly, a PAN reused across shops, a customer disputing every order — and
 * worked by admin_support. `autoActions` records what was already put in force when
 * the flag was raised, so an admin is not guessing.
 */
export const riskFlags = pgTable('risk_flags', {
  id: id(),
  ruleCode: text('rule_code').notNull(),
  severity: text('severity').$type<'low' | 'medium' | 'high' | 'critical'>().notNull().default('medium'),
  subjectType: text('subject_type').$type<'user' | 'shop' | 'order' | 'payment' | 'file'>().notNull(),
  subjectId: uuid('subject_id').notNull(),
  subjectLabel: text('subject_label'),
  /** What tripped, with the numbers that tripped it. */
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  /** Rolling contribution, so several small signals can add up. */
  score: integer('score').notNull().default(1),
  state: text('state')
    .$type<'open' | 'investigating' | 'confirmed' | 'dismissed' | 'auto_resolved'>()
    .notNull()
    .default('open'),
  assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
  resolution: text('resolution'),
  resolutionNote: text('resolution_note'),
  resolvedAt: tstz('resolved_at'),
  resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
  autoActions: text('auto_actions').array().notNull().default([]),
  ...timestamps,
})
