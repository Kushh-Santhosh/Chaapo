/**
 * Money — mirrors `db/migrations/0007_money.sql`.
 *
 * Chaapo is a marketplace and never holds customer money in a pooled account of its
 * own. The customer pays an aggregator, the aggregator holds the funds, and on
 * successful collection we instruct a transfer to the shop's registered account
 * minus commission (PRD §38, §40). Two consequences shape everything here:
 *
 *   • `payments` is a *mirror* of provider state, not a source of truth. Transitions
 *     arrive by signed webhook, are recorded in `paymentWebhookEvents` before being
 *     acted on, and are idempotent on the provider's event id (NFR-17).
 *   • `ledgerEntries` is double-entry and append-only. Each financial event is a
 *     balanced group sharing an `entryGroupId`; the balance is enforced by a
 *     deferred constraint trigger, so an unbalanced group fails at COMMIT.
 *     Corrections are reversing groups, never edits.
 */

import {
  boolean,
  integer,
  jsonb,
  pgTable,
  pgView,
  smallint,
  text,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

import { bigintCount, createdAt, id, paise, timestamps, tstz } from '../columns'
import {
  ledgerAccountEnum,
  ledgerDirectionEnum,
  paymentStateEnum,
  payoutStateEnum,
  refundStateEnum,
} from './enums'
import { users } from './identity'
import { orders } from './orders'
import { shopBankAccounts, shops } from './shops'

/** Providers we can talk to. `mock` is the local-dev adapter, not a fake success path. */
export type PaymentProvider = 'mock' | 'razorpay'

/**
 * Generic idempotency store, used by every mutating call a client might retry:
 * placement, payment initiation, accept, ready, collect, refund. The first request
 * records its response; a replay with the same key returns the stored response
 * rather than performing the action again (PRD §D, NFR-17).
 */
export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').primaryKey(),
  /** Namespace, so an order key and a refund key cannot collide. */
  scope: text('scope').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  /** Same key + different body is a client bug: rejected with 422, not answered. */
  requestHash: text('request_hash').notNull(),
  state: text('state').$type<'in_progress' | 'completed' | 'failed'>().notNull().default('in_progress'),
  responseStatus: integer('response_status'),
  responseBody: jsonb('response_body').$type<Record<string, unknown>>(),
  /** Held while the first request is in flight, so two retries do not both execute. */
  lockedAt: tstz('locked_at'),
  lockedBy: text('locked_by'),
  completedAt: tstz('completed_at'),
  errorCode: text('error_code'),
  attempts: integer('attempts').notNull().default(1),
  expiresAt: tstz('expires_at').notNull(),
  ...timestamps,
})

/**
 * A payment attempt. `orderId`, `provider`, `amountPaise` and `currency` are
 * immutable in place. A payment only reaches `captured` when `signatureVerified` is
 * true — we never mark money as received on a client-side callback alone (NFR-14).
 */
export const payments = pgTable('payments', {
  id: id(),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'restrict' }),
  customerUserId: uuid('customer_user_id')
    .notNull()
    .references(() => users.id),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id),

  provider: text('provider').$type<PaymentProvider>().notNull(),
  /** Provider order/intent id, created before the customer is redirected. */
  providerOrderId: text('provider_order_id'),
  /** Provider payment id, known only after an attempt. */
  providerPaymentId: text('provider_payment_id'),
  /** Route/split transfer id, created when we instruct the shop's share. */
  providerTransferId: text('provider_transfer_id'),
  /** The provider's linked-account/beneficiary id for this shop. */
  providerShopAccountId: text('provider_shop_account_id'),

  state: paymentStateEnum('state').notNull().default('created'),
  currency: text('currency').notNull().default('INR'),
  amountPaise: paise('amount_paise').notNull(),
  amountCapturedPaise: paise('amount_captured_paise').notNull().default(0n),
  amountRefundedPaise: paise('amount_refunded_paise').notNull().default(0n),

  /** Held on the aggregator side until collection, then released (PRD §40.2). */
  shopTransferPaise: paise('shop_transfer_paise').notNull().default(0n),
  platformKeepPaise: paise('platform_keep_paise').notNull().default(0n),
  transferOnHold: boolean('transfer_on_hold').notNull().default(true),
  transferReleasedAt: tstz('transfer_released_at'),

  /** A real cost, so it appears in the ledger rather than being quietly absorbed. */
  providerFeePaise: paise('provider_fee_paise').notNull().default(0n),
  providerTaxPaise: paise('provider_tax_paise').notNull().default(0n),

  method: text('method').$type<
    'upi' | 'card' | 'netbanking' | 'wallet' | 'emi' | 'paylater' | 'mock'
  >(),
  /** Masked descriptor for the receipt: 'UPI · rahul@okhdfc', 'Card ···4242'. */
  methodDisplay: text('method_display'),
  bank: text('bank'),
  wallet: text('wallet'),
  vpaMasked: text('vpa_masked'),

  attempts: integer('attempts').notNull().default(0),
  failureCode: text('failure_code'),
  /** Customer-safe sentence. Never raw provider text. */
  failureMessage: text('failure_message'),
  /** Raw provider reason, for support. Not returned on customer endpoints. */
  failureProviderReason: text('failure_provider_reason'),

  /** True only after HMAC verification of the provider's message. */
  signatureVerified: boolean('signature_verified').notNull().default(false),

  idempotencyKey: text('idempotency_key'),
  expiresAt: tstz('expires_at'),
  authorizedAt: tstz('authorized_at'),
  capturedAt: tstz('captured_at'),
  failedAt: tstz('failed_at'),
  cancelledAt: tstz('cancelled_at'),
  ...timestamps,
})

/**
 * Append-only webhook inbox. Every provider message is durably recorded *before* it
 * is interpreted, keyed on the provider's own event id. Redelivery is therefore
 * free, a buggy handler can be replayed, and a webhook storm cannot lose an event
 * (NFR-17, PRD §38.7). Only the processing bookkeeping columns may be updated.
 */
export const paymentWebhookEvents = pgTable('payment_webhook_events', {
  id: id(),
  provider: text('provider').$type<PaymentProvider>().notNull(),
  providerEventId: text('provider_event_id').notNull(),
  eventType: text('event_type').notNull(),
  /** As received, with card numbers and VPAs redacted by the handler before insert. */
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  signatureVerified: boolean('signature_verified').notNull(),
  signatureAlgorithm: text('signature_algorithm'),

  paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'set null' }),
  orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
  /** FK added later in migration 0007, once `refunds` exists. */
  refundId: uuid('refund_id'),

  receivedAt: tstz('received_at').notNull().defaultNow(),
  processedAt: tstz('processed_at'),
  processingAttempts: integer('processing_attempts').notNull().default(0),
  processingError: text('processing_error'),
  /** Set when the event duplicates one we already applied. */
  skippedReason: text('skipped_reason'),
  /** Provider clock, for ordering out-of-order deliveries. */
  providerCreatedAt: tstz('provider_created_at'),
})

/**
 * A refund. `borneBy` records whether the shop or the platform absorbs it, which is
 * what makes the payout maths honest. Refunds above a configured threshold need a
 * second pair of eyes from admin_finance (PRD §39.5).
 */
export const refunds = pgTable('refunds', {
  id: id(),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'restrict' }),
  paymentId: uuid('payment_id')
    .notNull()
    .references(() => payments.id, { onDelete: 'restrict' }),
  provider: text('provider').$type<PaymentProvider>().notNull(),
  providerRefundId: text('provider_refund_id'),

  state: refundStateEnum('state').notNull().default('requested'),
  amountPaise: paise('amount_paise').notNull(),
  isFull: boolean('is_full').notNull(),
  speed: text('speed').$type<'normal' | 'instant'>().notNull().default('normal'),

  reasonCode: text('reason_code')
    .$type<
      | 'order_cancelled_by_customer'
      | 'order_cancelled_by_shop'
      | 'order_rejected'
      | 'accept_window_expired'
      | 'hold_unresolved'
      | 'print_quality'
      | 'wrong_output'
      | 'not_collected'
      | 'duplicate_payment'
      | 'overcharge_correction'
      | 'dispute_resolution'
      | 'goodwill'
      | 'other'
    >()
    .notNull(),
  reasonText: text('reason_text'),
  /** The policy that produced this amount, snapshotted for later questions. */
  policyVersion: text('policy_version'),
  policyRateBps: integer('policy_rate_bps'),

  requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
  requestedActorType: text('requested_actor_type')
    .$type<'customer' | 'shop' | 'admin' | 'system'>()
    .notNull(),
  requiresApproval: boolean('requires_approval').notNull().default(false),
  approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
  approvedAt: tstz('approved_at'),
  rejectedBy: uuid('rejected_by').references(() => users.id, { onDelete: 'set null' }),
  rejectedAt: tstz('rejected_at'),
  rejectionReason: text('rejection_reason'),

  borneBy: text('borne_by').$type<'platform' | 'shop' | 'shared'>().notNull().default('platform'),

  idempotencyKey: text('idempotency_key'),
  processingStartedAt: tstz('processing_started_at'),
  succeededAt: tstz('succeeded_at'),
  failedAt: tstz('failed_at'),
  failureCode: text('failure_code'),
  failureMessage: text('failure_message'),
  /** Provider settlement reference, for the customer's bank statement. */
  providerReference: text('provider_reference'),
  expectedSettledBy: tstz('expected_settled_by'),
  ...timestamps,
})

/**
 * The double-entry ledger. Append-only, integer paise, one balanced group per
 * financial event. "Where did this ₹9.60 go" is always answerable, and a
 * reconciliation break is detectable rather than invisible.
 */
export const ledgerEntries = pgTable('ledger_entries', {
  id: id(),
  /** All entries of one event share this. Debits must equal credits at COMMIT. */
  entryGroupId: uuid('entry_group_id').notNull(),
  eventType: text('event_type')
    .$type<
      | 'payment_captured'
      | 'commission_earned'
      | 'commission_tax'
      | 'provider_fee'
      | 'funds_released'
      | 'refund_issued'
      | 'refund_reversed_commission'
      | 'payout_initiated'
      | 'payout_paid'
      | 'payout_reversed'
      | 'tds_withheld'
      | 'adjustment'
      | 'correction'
      | 'chargeback'
    >()
    .notNull(),
  sequenceInGroup: smallint('sequence_in_group').notNull().default(0),

  account: ledgerAccountEnum('account').notNull(),
  direction: ledgerDirectionEnum('direction').notNull(),
  amountPaise: paise('amount_paise').notNull(),
  currency: text('currency').notNull().default('INR'),

  /** Subject links. At least one of order/shop/payout is always present. */
  orderId: uuid('order_id').references(() => orders.id, { onDelete: 'restrict' }),
  shopId: uuid('shop_id').references(() => shops.id, { onDelete: 'restrict' }),
  paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'restrict' }),
  refundId: uuid('refund_id').references(() => refunds.id, { onDelete: 'restrict' }),
  /** FK added later in migration 0007, once `payouts` exists. */
  payoutId: uuid('payout_id'),

  description: text('description').notNull(),
  /** When the money actually moved, which is not always when we recorded it. */
  occurredAt: tstz('occurred_at').notNull().defaultNow(),
  /** The group this one reverses, if it is a correction. */
  reversesGroupId: uuid('reverses_group_id'),
  ...createdAt,
})

/**
 * A settlement window for one shop. Exactly one payout per shop is `accruing` — the
 * open window that collected orders land in. Money only ever leaves to a verified
 * destination, and never as a zero or negative transfer: a window that nets to
 * nothing carries forward as an adjustment.
 */
export const payouts = pgTable('payouts', {
  id: id(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'restrict' }),
  bankAccountId: uuid('bank_account_id').references(() => shopBankAccounts.id, {
    onDelete: 'restrict',
  }),
  /** Human reference for the dashboard and support conversations. */
  reference: text('reference').notNull(),

  state: payoutStateEnum('state').notNull().default('accruing'),
  periodStart: tstz('period_start').notNull(),
  periodEnd: tstz('period_end').notNull(),

  orderCount: integer('order_count').notNull().default(0),
  grossPaise: paise('gross_paise').notNull().default(0n),
  commissionPaise: paise('commission_paise').notNull().default(0n),
  commissionTaxPaise: paise('commission_tax_paise').notNull().default(0n),
  /** Section 194-O TDS, withheld and paid to the government on the shop's behalf. */
  tdsPaise: paise('tds_paise').notNull().default(0n),
  tdsRateBps: integer('tds_rate_bps').notNull().default(0),
  /** Refunds and corrections carried into this window. May be negative. */
  adjustmentsPaise: paise('adjustments_paise').notNull().default(0n),
  netPaise: paise('net_paise').notNull().default(0n),

  provider: text('provider').$type<PaymentProvider>(),
  providerPayoutId: text('provider_payout_id'),
  /** Bank reference the shop can quote to their bank. */
  utr: text('utr'),

  idempotencyKey: text('idempotency_key'),
  initiatedAt: tstz('initiated_at'),
  initiatedBy: uuid('initiated_by').references(() => users.id, { onDelete: 'set null' }),
  paidAt: tstz('paid_at'),
  failedAt: tstz('failed_at'),
  failureCode: text('failure_code'),
  failureMessage: text('failure_message'),
  retryCount: integer('retry_count').notNull().default(0),

  /** A payout can be frozen by risk rules, a dispute, or an admin — always with a reason. */
  holdReason: text('hold_reason'),
  heldAt: tstz('held_at'),
  heldBy: uuid('held_by').references(() => users.id, { onDelete: 'set null' }),
  releasedAt: tstz('released_at'),
  releasedBy: uuid('released_by').references(() => users.id, { onDelete: 'set null' }),

  statementStorageKey: text('statement_storage_key'),
  ...timestamps,
})

/**
 * One row per order in a payout, amounts snapshotted. An order can appear in exactly
 * one payout (`kind = 'order'`), enforced by a unique index — which is what makes
 * double payment impossible rather than merely unlikely (PRD §41.3). A `kind =
 * 'order'` row is also refused unless the order has actually been collected.
 */
export const payoutItems = pgTable('payout_items', {
  id: id(),
  payoutId: uuid('payout_id')
    .notNull()
    .references(() => payouts.id, { onDelete: 'cascade' }),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'restrict' }),
  kind: text('kind')
    .$type<'order' | 'adjustment' | 'refund_recovery' | 'correction'>()
    .notNull()
    .default('order'),
  orderTotalPaise: paise('order_total_paise').notNull(),
  commissionPaise: paise('commission_paise').notNull(),
  commissionTaxPaise: paise('commission_tax_paise').notNull(),
  refundedPaise: paise('refunded_paise').notNull().default(0n),
  netPaise: paise('net_paise').notNull(),
  /** For adjustment rows: what this corrects. */
  adjustmentReason: text('adjustment_reason'),
  ...createdAt,
})

/**
 * Sequential numbering per series per financial year. A GST requirement, not a
 * nicety (PRD §42).
 */
export const invoiceSeries = pgTable('invoice_series', {
  id: id(),
  code: text('code').notNull(),
  /** '2026-27'. */
  financialYear: text('financial_year').notNull(),
  prefix: text('prefix').notNull(),
  nextNumber: bigintCount('next_number').notNull().default(1n),
  ...timestamps,
})

/**
 * Two documents per completed order: the customer's receipt from the shop, and our
 * commission invoice to the shop. Party details are snapshotted so an invoice does
 * not change when a shop edits its address next year. Invoices are legal documents
 * and are never edited — a mistake is corrected by a credit note plus a fresh
 * invoice.
 */
export const invoices = pgTable('invoices', {
  id: id(),
  kind: text('kind')
    .$type<'customer_receipt' | 'commission_invoice' | 'credit_note' | 'payout_statement'>()
    .notNull(),
  seriesId: uuid('series_id')
    .notNull()
    .references(() => invoiceSeries.id),
  invoiceNumber: text('invoice_number').notNull(),
  sequenceNumber: bigintCount('sequence_number').notNull(),

  orderId: uuid('order_id').references(() => orders.id, { onDelete: 'restrict' }),
  payoutId: uuid('payout_id').references(() => payouts.id, { onDelete: 'restrict' }),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'restrict' }),
  customerUserId: uuid('customer_user_id').references(() => users.id, { onDelete: 'set null' }),

  issuedAt: tstz('issued_at').notNull().defaultNow(),
  supplierName: text('supplier_name').notNull(),
  supplierAddress: text('supplier_address').notNull(),
  supplierGstinMasked: text('supplier_gstin_masked'),
  recipientName: text('recipient_name').notNull(),
  recipientAddress: text('recipient_address'),
  recipientGstinMasked: text('recipient_gstin_masked'),
  placeOfSupply: text('place_of_supply'),

  taxablePaise: paise('taxable_paise').notNull(),
  cgstPaise: paise('cgst_paise').notNull().default(0n),
  sgstPaise: paise('sgst_paise').notNull().default(0n),
  igstPaise: paise('igst_paise').notNull().default(0n),
  totalPaise: paise('total_paise').notNull(),
  hsnSac: text('hsn_sac'),
  lineItems: jsonb('line_items').$type<Record<string, unknown>[]>().notNull(),

  storageKey: text('storage_key'),
  storageBucket: text('storage_bucket'),
  /** Cancellation is a credit note, not a delete. */
  cancelledAt: tstz('cancelled_at'),
  creditNoteForId: uuid('credit_note_for_id').references((): AnyPgColumn => invoices.id, {
    onDelete: 'restrict',
  }),
  ...createdAt,
})

/**
 * Derived from the ledger, never stored. The dashboard's "₹4,320 awaiting payout" is
 * a query against this view, so it cannot drift from the ledger it summarises.
 *
 * Declared as an existing view: the SQL in migration 0007 owns the definition.
 */
export const shopBalances = pgView('shop_balances', {
  shopId: uuid('shop_id'),
  payablePaise: paise('payable_paise'),
  settledPaise: paise('settled_paise'),
  lastMovementAt: tstz('last_movement_at'),
}).existing()
