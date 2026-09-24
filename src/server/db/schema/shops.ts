/**
 * Shops, staff, capabilities, KYC and payout destinations — mirrors
 * `db/migrations/0003_geography_and_shops.sql`.
 *
 * The one column here that must never be written is `shops.discoverable`: it is
 * GENERATED in the database from status, verification, location and deletion, so
 * there is exactly one definition of "may appear in discovery" (NFR-10). It is
 * declared with `generatedAlwaysAs` below, which keeps it out of drizzle's insert
 * and update types — the type system refuses the mistake rather than trusting us
 * not to make it.
 */

import { sql } from 'drizzle-orm'
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  uuid,
} from 'drizzle-orm/pg-core'

import { citext, createdAt, geographyPoint, id, paise, softDelete, timestamps, tstz } from '../columns'
import { shopStatusEnum, userRoleEnum, verificationStatusEnum } from './enums'
import { cities, localities } from './geo'
import { users } from './identity'

/**
 * The shop.
 *
 * Cached aggregates (`ratingAvgCenti`, `onTimeRateBps`, …) are denormalised on
 * purpose: discovery renders them on every card and cannot afford two aggregate
 * joins per shop (NFR-02). They are recomputed by a worker and are never
 * authoritative — `order_ratings` and `orders` are.
 */
export const shops = pgTable('shops', {
  id: id(),
  slug: citext('slug').notNull(),
  name: text('name').notNull(),
  /** Registered legal name, used on invoices. Not shown in discovery. */
  legalName: text('legal_name'),
  tagline: text('tagline'),
  about: text('about'),
  ownerUserId: uuid('owner_user_id')
    .notNull()
    .references(() => users.id),

  status: shopStatusEnum('status').notNull().default('draft'),
  verificationStatus: verificationStatusEnum('verification_status')
    .notNull()
    .default('not_submitted'),
  verifiedAt: tstz('verified_at'),
  verifiedBy: uuid('verified_by').references(() => users.id),

  addressLine1: text('address_line1').notNull().default(''),
  addressLine2: text('address_line2'),
  landmark: text('landmark'),
  cityId: uuid('city_id').references(() => cities.id),
  localityId: uuid('locality_id').references(() => localities.id),
  pincode: text('pincode'),
  location: geographyPoint('location'),
  /** How the pin was obtained, so a verifier can tell a hand-drop from a geocode. */
  locationSource: text('location_source').$type<'device_gps' | 'map_pin' | 'geocoded' | 'admin'>(),
  locationAccuracyM: integer('location_accuracy_m'),

  contactPhoneEncrypted: text('contact_phone_encrypted'),
  contactPhoneHash: text('contact_phone_hash'),
  contactPhoneMasked: text('contact_phone_masked'),
  contactEmailEncrypted: text('contact_email_encrypted'),
  contactEmailMasked: text('contact_email_masked'),
  /** Off by default; shops opt in to showing their number to a live customer. */
  showPhoneToCustomer: boolean('show_phone_to_customer').notNull().default(false),

  /** Base turnaround in *open* minutes — the SLA clock runs on shop hours. */
  defaultTurnaroundMinutes: integer('default_turnaround_minutes').notNull().default(30),
  /** How long the shop has to accept before the order auto-cancels (FR-407). */
  acceptWindowMinutes: integer('accept_window_minutes').notNull().default(10),
  /** How long a Ready order waits before the grace timer starts (FR-431). */
  pickupGraceHours: integer('pickup_grace_hours').notNull().default(48),
  /** NULL means "use the platform default from platform_config". */
  maxPagesPerOrder: integer('max_pages_per_order'),
  maxFilesPerOrder: integer('max_files_per_order'),
  minOrderValuePaise: paise('min_order_value_paise').notNull().default(0n),

  /** Per-shop commission override in basis points. NULL means the platform rate. */
  commissionBps: integer('commission_bps'),

  /** Rating × 100 as an integer. 431 = 4.31 stars. */
  ratingAvgCenti: integer('rating_avg_centi'),
  ratingCount: integer('rating_count').notNull().default(0),
  ordersCompleted: integer('orders_completed').notNull().default(0),
  onTimeRateBps: integer('on_time_rate_bps'),
  acceptanceRateBps: integer('acceptance_rate_bps'),
  medianReadyMinutes: integer('median_ready_minutes'),
  aggregatesUpdatedAt: tstz('aggregates_updated_at'),

  /** The dashboard's "busy, back in 40 minutes" toggle (FR-206). */
  pausedUntil: tstz('paused_until'),
  pauseReason: text('pause_reason'),

  suspendedAt: tstz('suspended_at'),
  suspendedBy: uuid('suspended_by').references(() => users.id),
  suspensionReason: text('suspension_reason'),

  onboardingStep: text('onboarding_step')
    .$type<
      | 'profile'
      | 'location'
      | 'hours'
      | 'capabilities'
      | 'catalogue'
      | 'kyc'
      | 'bank'
      | 'review'
      | 'done'
    >()
    .notNull()
    .default('profile'),
  submittedForReviewAt: tstz('submitted_for_review_at'),
  wentLiveAt: tstz('went_live_at'),

  ...timestamps,
  ...softDelete,

  /**
   * GENERATED ALWAYS ... STORED. Read it, filter on it, never write it.
   * The expression must stay identical to the one in migration 0003.
   */
  discoverable: boolean('discoverable').generatedAlwaysAs(
    sql`status = 'live' AND verification_status = 'verified' AND location IS NOT NULL AND deleted_at IS NULL AND suspended_at IS NULL`,
  ),
})

/**
 * Opening hours: one row per interval per weekday, so a split shift (9–14, 16–21)
 * is two rows. Minutes from IST midnight; `closeMinute` may exceed 1440 for a shop
 * that shuts after midnight. Exactly the shape `WeeklyHours` in `src/lib/time.ts`
 * consumes.
 */
export const shopHours = pgTable('shop_hours', {
  id: id(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  /** 0 = Sunday. */
  weekday: smallint('weekday').notNull(),
  openMinute: integer('open_minute').notNull(),
  closeMinute: integer('close_minute').notNull(),
  ...timestamps,
})

/** Holidays and one-off shutdowns. */
export const shopClosures = pgTable('shop_closures', {
  id: id(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  startsAt: tstz('starts_at').notNull(),
  endsAt: tstz('ends_at').notNull(),
  reason: text('reason'),
  /** Whether customers see the reason ("Diwali") or just "Closed". */
  reasonPublic: boolean('reason_public').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
  ...timestamps,
})

/**
 * A staff member is a user holding a shop-scoped role; this table carries the
 * shop-specific facts. The role opens the dashboard, these flags decide whether
 * this person can refund, change prices or see payouts.
 */
export const shopStaff = pgTable('shop_staff', {
  id: id(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
  canAcceptOrders: boolean('can_accept_orders').notNull().default(true),
  canVerifyPickup: boolean('can_verify_pickup').notNull().default(true),
  canEditCatalogue: boolean('can_edit_catalogue').notNull().default(false),
  canViewPayouts: boolean('can_view_payouts').notNull().default(false),
  canManageStaff: boolean('can_manage_staff').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  invitedBy: uuid('invited_by').references(() => users.id),
  joinedAt: tstz('joined_at').notNull().defaultNow(),
  removedAt: tstz('removed_at'),
  ...timestamps,
})

/** Pending invitations to join a shop's staff. Token stored hashed. */
export const staffInvites = pgTable('staff_invites', {
  id: id(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  invitedBy: uuid('invited_by')
    .notNull()
    .references(() => users.id),
  phoneEncrypted: text('phone_encrypted').notNull(),
  phoneHash: text('phone_hash').notNull(),
  phoneMasked: text('phone_masked').notNull(),
  displayName: text('display_name').notNull(),
  role: userRoleEnum('role').notNull(),
  permissions: jsonb('permissions').$type<Record<string, boolean>>().notNull().default({}),
  tokenHash: text('token_hash').notNull(),
  expiresAt: tstz('expires_at').notNull(),
  acceptedAt: tstz('accepted_at'),
  acceptedUserId: uuid('accepted_user_id').references(() => users.id),
  revokedAt: tstz('revoked_at'),
  ...timestamps,
})

/**
 * What the shop's machines can physically do. Discovery filters on this before it
 * filters on price, because a shop that cannot print A3 colour is not a candidate
 * for an A3 colour job at any price (FR-104).
 */
export const shopCapabilities = pgTable('shop_capabilities', {
  shopId: uuid('shop_id')
    .primaryKey()
    .references(() => shops.id, { onDelete: 'cascade' }),
  /** Paper size catalogue codes: 'a4', 'a3', 'legal', … */
  paperSizes: text('paper_sizes').array().notNull().default(['a4']),
  supportsColour: boolean('supports_colour').notNull().default(false),
  supportsBw: boolean('supports_bw').notNull().default(true),
  supportsDuplex: boolean('supports_duplex').notNull().default(true),
  /** Finishing codes: 'staple', 'spiral', 'soft_bind', 'lamination', … */
  finishings: text('finishings').array().notNull().default([]),
  supportsCardStock: boolean('supports_card_stock').notNull().default(false),
  supportsPhotoPaper: boolean('supports_photo_paper').notNull().default(false),
  supportsLargeFormat: boolean('supports_large_format').notNull().default(false),
  supportsScanning: boolean('supports_scanning').notNull().default(false),
  dailyPageCapacity: integer('daily_page_capacity'),
  /** Drives concurrency in the SLA estimate. */
  printerCount: smallint('printer_count').notNull().default(1),
  notes: text('notes'),
  ...timestamps,
})

/**
 * Shop KYC.
 *
 * PAN and GSTIN are encrypted with blind indexes, so the trust queue can detect the
 * same PAN on two shops — a real fraud pattern — without holding the numbers in the
 * clear. Aadhaar numbers are never stored in any form, not even the last four
 * digits; only the provider's opaque reference is kept (PRD §57.2).
 */
export const shopKyc = pgTable('shop_kyc', {
  shopId: uuid('shop_id')
    .primaryKey()
    .references(() => shops.id, { onDelete: 'cascade' }),
  businessType: text('business_type')
    .$type<'proprietorship' | 'partnership' | 'llp' | 'private_limited' | 'other'>()
    .notNull()
    .default('proprietorship'),

  panEncrypted: text('pan_encrypted'),
  panHash: text('pan_hash'),
  panMasked: text('pan_masked'),
  /** Name as printed on the PAN card. */
  panName: text('pan_name'),
  panVerifiedAt: tstz('pan_verified_at'),

  gstinEncrypted: text('gstin_encrypted'),
  gstinHash: text('gstin_hash'),
  gstinMasked: text('gstin_masked'),
  gstinVerifiedAt: tstz('gstin_verified_at'),
  /** Shops below the threshold legitimately have no GSTIN. */
  gstRegistered: boolean('gst_registered').notNull().default(false),

  /** Only the provider's opaque e-KYC reference — never the Aadhaar number. */
  aadhaarRefEncrypted: text('aadhaar_ref_encrypted'),
  aadhaarVerifiedAt: tstz('aadhaar_verified_at'),

  /** Object keys in the private KYC bucket. Never public URLs. */
  shopPhotoKey: text('shop_photo_key'),
  signboardPhotoKey: text('signboard_photo_key'),
  addressProofKey: text('address_proof_key'),
  addressProofType: text('address_proof_type'),

  status: verificationStatusEnum('status').notNull().default('not_submitted'),
  submittedAt: tstz('submitted_at'),
  reviewedAt: tstz('reviewed_at'),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  rejectionReason: text('rejection_reason'),
  /** Shown to the owner. Internal notes live on shopVerificationEvents. */
  reviewerNotesPublic: text('reviewer_notes_public'),
  expiresAt: tstz('expires_at'),

  ...timestamps,
})

/**
 * Payout destinations.
 *
 * Changing one is the highest-risk self-service action in the product — it is how a
 * compromised shop account gets monetised — so a change requires TOTP, is audited,
 * and freezes payouts until `holdPayoutsUntil` (PRD §41.5). The account number,
 * IFSC and shop are immutable in place: a different account is a different row, so
 * every payout can be traced to the destination that was live at the time.
 */
export const shopBankAccounts = pgTable('shop_bank_accounts', {
  id: id(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  accountHolderName: text('account_holder_name').notNull(),
  accountNumberEncrypted: text('account_number_encrypted').notNull(),
  accountNumberHash: text('account_number_hash').notNull(),
  accountNumberLast4: text('account_number_last4').notNull(),
  ifsc: text('ifsc').notNull(),
  bankName: text('bank_name'),
  branchName: text('branch_name'),
  accountType: text('account_type').$type<'savings' | 'current'>().notNull().default('savings'),

  /** Penny-drop verification through the payment provider. */
  verificationStatus: verificationStatusEnum('verification_status')
    .notNull()
    .default('not_submitted'),
  verifiedAt: tstz('verified_at'),
  verificationReference: text('verification_reference'),
  verificationFailure: text('verification_failure'),
  /** Name the penny drop returned. A mismatch holds the account for review. */
  verifiedHolderName: text('verified_holder_name'),

  isPrimary: boolean('is_primary').notNull().default(false),
  holdPayoutsUntil: tstz('hold_payouts_until'),
  /** Provider-side beneficiary id, so we do not re-register on every payout. */
  providerAccountId: text('provider_account_id'),

  createdBy: uuid('created_by').references(() => users.id),
  ...timestamps,
  archivedAt: tstz('archived_at'),
})

/**
 * Append-only trust decision log for a shop: submitted, changes requested,
 * approved, suspended, reinstated — with who and why (FR-802, NFR-16).
 * `internalNote` must never be returned on a shop-facing endpoint.
 */
export const shopVerificationEvents = pgTable('shop_verification_events', {
  id: id(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  event: text('event')
    .$type<
      | 'submitted'
      | 'changes_requested'
      | 'resubmitted'
      | 'approved'
      | 'rejected'
      | 'suspended'
      | 'reinstated'
      | 'paused'
      | 'unpaused'
      | 'closed'
      | 'kyc_verified'
      | 'kyc_rejected'
      | 'bank_verified'
      | 'bank_rejected'
      | 'documents_uploaded'
      | 'reverification_due'
      | 'note_added'
    >()
    .notNull(),
  fromStatus: shopStatusEnum('from_status'),
  toStatus: shopStatusEnum('to_status'),
  fromVerification: verificationStatusEnum('from_verification'),
  toVerification: verificationStatusEnum('to_verification'),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  actorRole: userRoleEnum('actor_role'),
  publicNote: text('public_note'),
  internalNote: text('internal_note'),
  /** Which checks were performed, as a structured record. */
  checks: jsonb('checks').$type<Record<string, unknown>>().notNull().default({}),
  ...createdAt,
})

/** Customer favourites. Composite key; no surrogate id needed. */
export const favouriteShops = pgTable(
  'favourite_shops',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    ...createdAt,
  },
  (t) => [primaryKey({ columns: [t.userId, t.shopId] })],
)
