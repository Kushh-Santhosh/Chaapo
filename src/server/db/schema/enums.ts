/**
 * Postgres enum types, mirroring `db/migrations/0001_extensions_and_types.sql`.
 *
 * The value arrays are also the runtime source of truth for the application: the
 * order state machine, RBAC checks and zod schemas all read from these rather than
 * repeating string literals, so adding a state means touching the migration and
 * this file, and nowhere else.
 */

import { pgEnum } from 'drizzle-orm/pg-core'

/** PRD §14 — the six roles. */
export const userRoleEnum = pgEnum('user_role', [
  'customer',
  'shop_owner',
  'shop_staff',
  'admin_support',
  'admin_finance',
  'admin_super',
])

export const accountStatusEnum = pgEnum('account_status', [
  'active',
  'pending_verification',
  'suspended',
  'closed',
])

/** PRD §17 — shop lifecycle. Only `live` shops can be discoverable (NFR-10). */
export const shopStatusEnum = pgEnum('shop_status', [
  'draft',
  'pending_review',
  'changes_requested',
  'live',
  'paused',
  'suspended',
  'closed',
])

export const verificationStatusEnum = pgEnum('verification_status', [
  'not_submitted',
  'pending',
  'in_review',
  'verified',
  'rejected',
  'expired',
])

/** PRD §F — the order state machine. Twenty states, no more, no fewer. */
export const orderStateEnum = pgEnum('order_state', [
  'draft',
  'awaiting_quote',
  'payment_pending',
  'failed',
  'placed',
  'accepted',
  'printing',
  'on_hold_file_issue',
  'ready',
  'collected',
  'settled',
  'rejected',
  'auto_cancelled',
  'cancelled_by_customer',
  'cancelled_by_shop',
  'expired',
  'refunded',
  'partially_refunded',
  'closed_no_refund',
  'disputed',
])

export const paymentStateEnum = pgEnum('payment_state', [
  'created',
  'pending',
  'authorized',
  'captured',
  'failed',
  'cancelled',
  'refund_pending',
  'refunded',
  'partially_refunded',
  'disputed',
])

export const payoutStateEnum = pgEnum('payout_state', [
  'accruing',
  'pending',
  'processing',
  'paid',
  'failed',
  'on_hold',
  'reversed',
])

export const refundStateEnum = pgEnum('refund_state', [
  'requested',
  'approved',
  'processing',
  'succeeded',
  'failed',
  'rejected',
])

export const fileStateEnum = pgEnum('file_state', [
  'reserved',
  'uploading',
  'uploaded',
  'scanning',
  'processing',
  'ready',
  'rejected',
  'expired',
  'deleted',
])

export const notificationChannelEnum = pgEnum('notification_channel', [
  'whatsapp',
  'sms',
  'email',
  'push',
  'in_app',
])

export const notificationStateEnum = pgEnum('notification_state', [
  'queued',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
  'suppressed',
])

export const disputeStateEnum = pgEnum('dispute_state', [
  'open',
  'awaiting_customer',
  'awaiting_shop',
  'in_review',
  'resolved_refund',
  'resolved_no_refund',
  'resolved_partial',
  'withdrawn',
])

/** Which side of the marketplace an amount belongs to. Used by the ledger. */
export const ledgerAccountEnum = pgEnum('ledger_account', [
  'customer_payment',
  'shop_payable',
  'platform_revenue',
  'tax_payable',
  'provider_fee',
  'refund_payable',
  'settlement_paid',
])

export const ledgerDirectionEnum = pgEnum('ledger_direction', ['debit', 'credit'])

// ── Derived TypeScript unions ─────────────────────────────────────────────────
// Exported so the domain layer never re-declares a state literal by hand.

export type UserRole = (typeof userRoleEnum.enumValues)[number]
export type AccountStatus = (typeof accountStatusEnum.enumValues)[number]
export type ShopStatus = (typeof shopStatusEnum.enumValues)[number]
export type VerificationStatus = (typeof verificationStatusEnum.enumValues)[number]
export type OrderState = (typeof orderStateEnum.enumValues)[number]
export type PaymentState = (typeof paymentStateEnum.enumValues)[number]
export type PayoutState = (typeof payoutStateEnum.enumValues)[number]
export type RefundState = (typeof refundStateEnum.enumValues)[number]
export type FileState = (typeof fileStateEnum.enumValues)[number]
export type NotificationChannel = (typeof notificationChannelEnum.enumValues)[number]
export type NotificationState = (typeof notificationStateEnum.enumValues)[number]
export type DisputeState = (typeof disputeStateEnum.enumValues)[number]
export type LedgerAccount = (typeof ledgerAccountEnum.enumValues)[number]
export type LedgerDirection = (typeof ledgerDirectionEnum.enumValues)[number]

export const ORDER_STATES = orderStateEnum.enumValues
export const USER_ROLES = userRoleEnum.enumValues
export const NOTIFICATION_CHANNELS = notificationChannelEnum.enumValues

/**
 * States in which the customer's money is held by the aggregator and the order is
 * still live. Mirrors the `orders_paid_states` CHECK in 0006.
 */
export const PAID_ORDER_STATES: readonly OrderState[] = [
  'placed',
  'accepted',
  'printing',
  'ready',
  'collected',
  'settled',
] as const

/** States a shop dashboard treats as "work in the shop right now". */
export const ACTIVE_SHOP_ORDER_STATES: readonly OrderState[] = [
  'placed',
  'accepted',
  'printing',
  'on_hold_file_issue',
  'ready',
] as const

/** States from which nothing further can happen without an admin. */
export const TERMINAL_ORDER_STATES: readonly OrderState[] = [
  'refunded',
  'closed_no_refund',
] as const
