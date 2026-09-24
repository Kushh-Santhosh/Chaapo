/**
 * Identity, sessions and access control — mirrors `db/migrations/0002_identity.sql`.
 *
 * Scope of these definitions: tables, columns, types, nullability and defaults.
 * Indexes, CHECK constraints and triggers are deliberately NOT repeated here — the
 * SQL owns them, and duplicating them in TypeScript would create two places to be
 * wrong. Foreign keys are declared only when the target table lives in this module,
 * to keep the module graph acyclic; the database enforces all of them regardless.
 *
 * `schema-parity.itest.ts` asserts that every column below exists in the live
 * database with the same type, and that no column exists there without appearing
 * here.
 */

import { boolean, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core'

import { bigintCount, createdAt, id, softDelete, timestamps, tstz } from '../columns'
import { accountStatusEnum, notificationChannelEnum, userRoleEnum } from './enums'

/**
 * One row per human. Phone is the primary credential; it is stored encrypted with
 * a keyed-HMAC blind index (`phoneHash`) for lookup and a masked form for display.
 * Nothing identifying in this table can be read without the data key.
 */
export const users = pgTable('users', {
  id: id(),
  phoneEncrypted: text('phone_encrypted').notNull(),
  phoneHash: text('phone_hash').notNull(),
  phoneMasked: text('phone_masked').notNull(),
  phoneVerifiedAt: tstz('phone_verified_at'),
  emailEncrypted: text('email_encrypted'),
  emailHash: text('email_hash'),
  emailMasked: text('email_masked'),
  emailVerifiedAt: tstz('email_verified_at'),
  fullName: text('full_name'),
  passwordHash: text('password_hash'),
  passwordUpdatedAt: tstz('password_updated_at'),
  status: accountStatusEnum('status').notNull().default('active'),
  locale: text('locale').notNull().default('en-IN'),
  lastIpHash: text('last_ip_hash'),
  lastLoginAt: tstz('last_login_at'),
  erasureRequestedAt: tstz('erasure_requested_at'),
  erasedAt: tstz('erased_at'),
  ...timestamps,
  ...softDelete,
})

/**
 * Roles as rows, not as a column on `users`. Shop-scoped roles carry `shopId`;
 * platform roles must not. Revocation sets `revokedAt` rather than deleting, so
 * "who could do what, when" is answerable a year later (PRD §14).
 */
export const userRoles = pgTable('user_roles', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: userRoleEnum('role').notNull(),
  // FK to shops, added in migration 0003 once that table exists.
  shopId: uuid('shop_id'),
  grantedBy: uuid('granted_by').references(() => users.id),
  grantedAt: tstz('granted_at').notNull().defaultNow(),
  revokedAt: tstz('revoked_at'),
  revokedBy: uuid('revoked_by').references(() => users.id),
  revokeReason: text('revoke_reason'),
  ...timestamps,
})

/**
 * Opaque session tokens, stored hashed, so a database dump cannot be replayed as a
 * live session. `surface` is load-bearing: a session issued for the shop dashboard
 * cannot authorise an admin route even when the same person holds both roles.
 */
export const sessions = pgTable('sessions', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  refreshTokenHash: text('refresh_token_hash').notNull(),
  refreshGeneration: integer('refresh_generation').notNull().default(1),
  surface: text('surface').$type<'customer' | 'shop' | 'admin'>().notNull(),
  activeRole: userRoleEnum('active_role').notNull(),
  // FK to shops, added in migration 0003.
  activeShopId: uuid('active_shop_id'),
  deviceEncrypted: text('device_encrypted'),
  ipHash: text('ip_hash'),
  mfaSatisfiedAt: tstz('mfa_satisfied_at'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
  expiresAt: tstz('expires_at').notNull(),
  absoluteExpiresAt: tstz('absolute_expires_at').notNull(),
  revokedAt: tstz('revoked_at'),
  revokeReason: text('revoke_reason'),
})

/**
 * OTP challenges. Codes are hashed, attempts are counted, expiry is absolute, and
 * a consumed challenge can never be reused. Redis handles rate limiting; this table
 * is the correctness boundary and the audit record (FR-002, NFR-14).
 */
export const otpChallenges = pgTable('otp_challenges', {
  id: id(),
  purpose: text('purpose')
    .$type<
      | 'login'
      | 'signup'
      | 'phone_change'
      | 'email_verify'
      | 'password_reset'
      | 'staff_invite'
      | 'high_value_confirm'
    >()
    .notNull(),
  destinationHash: text('destination_hash').notNull(),
  channel: notificationChannelEnum('channel').notNull(),
  codeHash: text('code_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  resendCount: integer('resend_count').notNull().default(0),
  consumedAt: tstz('consumed_at'),
  lockedAt: tstz('locked_at'),
  expiresAt: tstz('expires_at').notNull(),
  requestedIpHash: text('requested_ip_hash'),
  ...timestamps,
})

/** TOTP second factor. Required for admins and for shop actions that move money. */
export const userTotp = pgTable('user_totp', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  secretEncrypted: text('secret_encrypted').notNull(),
  confirmedAt: tstz('confirmed_at'),
  lastUsedAt: tstz('last_used_at'),
  // The last accepted time step, so a code cannot be replayed inside its window.
  lastUsedCounter: bigintCount('last_used_counter'),
  recoveryCodeHashes: text('recovery_code_hashes').array().notNull().default([]),
  recoveryCodesUsed: integer('recovery_codes_used').notNull().default(0),
  ...timestamps,
})

/** The security timeline an admin reads when investigating account takeover. */
export const loginAttempts = pgTable('login_attempts', {
  id: id(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  identifierHash: text('identifier_hash').notNull(),
  surface: text('surface').$type<'customer' | 'shop' | 'admin'>().notNull(),
  method: text('method')
    .$type<'otp' | 'password' | 'totp' | 'recovery_code' | 'refresh'>()
    .notNull(),
  outcome: text('outcome').$type<'success' | 'failure' | 'locked' | 'throttled'>().notNull(),
  failureReason: text('failure_reason'),
  ipHash: text('ip_hash'),
  userAgentFamily: text('user_agent_family'),
  ...createdAt,
})

/**
 * Web push subscriptions. The endpoint is a capability URL — anyone holding it can
 * push to that device — so it is treated as a secret and stored encrypted, with a
 * hash for lookup.
 */
export const pushSubscriptions = pgTable('push_subscriptions', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  endpointHash: text('endpoint_hash').notNull(),
  endpointEncrypted: text('endpoint_encrypted').notNull(),
  p256dhEncrypted: text('p256dh_encrypted').notNull(),
  authEncrypted: text('auth_encrypted').notNull(),
  surface: text('surface').$type<'customer' | 'shop' | 'admin'>().notNull(),
  userAgentFamily: text('user_agent_family'),
  failureCount: integer('failure_count').notNull().default(0),
  lastSuccessAt: tstz('last_success_at'),
  lastFailureAt: tstz('last_failure_at'),
  // Set when the push service returns 404/410: the subscription is gone.
  expiredAt: tstz('expired_at'),
  ...timestamps,
})

/**
 * Per-purpose, per-channel notification preferences. Transactional order updates
 * are not marketing and cannot be switched off entirely, but the channel is the
 * customer's choice (FR-901).
 */
export const notificationPreferences = pgTable('notification_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  orderUpdatesChannels: notificationChannelEnum('order_updates_channels')
    .array()
    .notNull()
    .default(['push', 'whatsapp']),
  marketingOptedIn: boolean('marketing_opted_in').notNull().default(false),
  marketingOptedInAt: tstz('marketing_opted_in_at'),
  marketingChannels: notificationChannelEnum('marketing_channels').array().notNull().default([]),
  // IST minutes from midnight. Transactional messages ignore these.
  quietHoursStart: integer('quiet_hours_start'),
  quietHoursEnd: integer('quiet_hours_end'),
  ...timestamps,
})

/**
 * DPDP consent records. Append-only: a consent is evidence, so withdrawal writes a
 * new row rather than deleting the grant. `noticeHash` pins the exact wording that
 * was shown, so we can prove it after the policy text changes (PRD §57.1).
 */
export const consents = pgTable('consents', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  purpose: text('purpose')
    .$type<
      'account' | 'order_files' | 'transactional_messaging' | 'marketing' | 'location' | 'analytics'
    >()
    .notNull(),
  version: text('version').notNull(),
  granted: boolean('granted').notNull(),
  noticeHash: text('notice_hash').notNull(),
  source: text('source').$type<'signup' | 'settings' | 'checkout' | 'admin' | 'import'>().notNull(),
  ipHash: text('ip_hash'),
  ...createdAt,
})
