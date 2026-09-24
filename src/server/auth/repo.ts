/**
 * Auth data access.
 *
 * Thin on purpose: one function per query, no decisions. Whether an OTP is correct,
 * how long a session lives and what an actor may do all live above this file — here
 * there is only SQL. The value of the split is that `service.ts` can be read as a
 * sequence of policy decisions without a query in the way, and that the handful of
 * queries below which *are* load-bearing can be read closely.
 *
 * Three conventions worth stating once.
 *
 * **`db` is the first parameter and has no default.** Every function takes a
 * `DbHandle`, so the same function works inside a transaction and outside one. It
 * deliberately does *not* default to `getDb()`: a repository call that silently
 * escapes its caller's transaction is how a session insert commits while the audit row
 * that was supposed to accompany it rolls back. The caller always knows which handle
 * it is holding, so it can say so.
 *
 * **Guards live in the `WHERE` clause, not in a preceding `SELECT`.** Consuming an OTP,
 * rotating a refresh token and accepting a TOTP counter are all written as conditional
 * updates that return the row on success and nothing when the condition failed. A
 * read-then-write would let two concurrent requests both pass the read — which for
 * these three means a code used twice, a stolen refresh token that looks legitimate,
 * and a replayed TOTP. `null` from those functions means "somebody else got there
 * first", which the caller must treat as a failure and not as a missing row.
 *
 * **`updated_at` is never set here.** `set_updated_at()` triggers own it (migration
 * 0002). `sessions` has no such column at all, so its writes touch `last_seen_at`.
 *
 * Every finder ignores soft-deleted users, matching the partial unique indexes. The
 * retention and erasure workers, which must see deleted rows, use their own queries.
 */

import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm'

import { newId } from '../../lib/ids'
import type { Surface } from '../core/rbac'
import type { DbHandle } from '../db/client'
import type { AccountStatus, NotificationChannel, UserRole } from '../db/schema/enums'
import {
  loginAttempts,
  otpChallenges,
  sessions,
  userRoles,
  users,
  userTotp,
} from '../db/schema/identity'

// ── Row types ───────────────────────────────────────────────────────────────
// Derived from the schema rather than restated, so a column change is a type error
// here rather than a runtime surprise.

export type UserRow = typeof users.$inferSelect
export type UserRoleRow = typeof userRoles.$inferSelect
export type SessionRow = typeof sessions.$inferSelect
export type OtpChallengeRow = typeof otpChallenges.$inferSelect
export type UserTotpRow = typeof userTotp.$inferSelect
export type LoginAttemptRow = typeof loginAttempts.$inferSelect

export type OtpPurpose = OtpChallengeRow['purpose']
export type LoginMethod = LoginAttemptRow['method']
export type LoginOutcome = LoginAttemptRow['outcome']

/** `rows[0] ?? null`, spelled once. `noUncheckedIndexedAccess` makes this necessary. */
function one<T>(rows: T[]): T | null {
  return rows[0] ?? null
}

/**
 * An `INSERT ... RETURNING` that returned nothing did not insert anything, which is
 * not a product outcome — it is a broken assumption about the database.
 */
function inserted<T>(rows: T[], what: string): T {
  const row = rows[0]
  if (!row) throw new Error(`${what}: insert returned no row`)
  return row
}

/** A timestamp for a raw `sql` fragment, typed so Postgres never has to guess. */
function asTimestamp(instant: Date) {
  return sql`${instant.toISOString()}::timestamptz`
}

// ═══════════════════════════════════════════════════════════════════════════
// Users
// ═══════════════════════════════════════════════════════════════════════════

export async function findUserById(db: DbHandle, userId: string): Promise<UserRow | null> {
  return one(
    await db
      .select()
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1),
  )
}

/**
 * Look a user up by the blind index of their phone number.
 *
 * `phoneHash` comes from `hashPhone()`; the number itself never reaches this layer.
 * Hits `users_phone_hash_key`, which is partial on `deleted_at IS NULL` — hence the
 * matching predicate, without which the index would not be used and a closed account
 * would shadow a new one.
 */
export async function findUserByPhoneHash(db: DbHandle, phoneHash: string): Promise<UserRow | null> {
  return one(
    await db
      .select()
      .from(users)
      .where(and(eq(users.phoneHash, phoneHash), isNull(users.deletedAt)))
      .limit(1),
  )
}

export async function findUserByEmailHash(db: DbHandle, emailHash: string): Promise<UserRow | null> {
  return one(
    await db
      .select()
      .from(users)
      .where(and(eq(users.emailHash, emailHash), isNull(users.deletedAt)))
      .limit(1),
  )
}

export interface NewUser {
  /** Supplied when the caller needs the id before the insert; generated otherwise. */
  id?: string
  /**
   * The PII triple. Grouped rather than three loose columns because the encrypted
   * value, the blind index and the mask must describe the same number — a mask from
   * one number beside the ciphertext of another is undetectable afterwards.
   */
  phone: { encrypted: string; hash: string; masked: string; verifiedAt?: Date | null }
  email?: { encrypted: string; hash: string; masked: string; verifiedAt?: Date | null }
  fullName?: string | null
  /**
   * Both halves or neither: `users_password_needs_timestamp` requires the hash and
   * its timestamp to agree about whether a password exists, and a nested object makes
   * the half-set state unrepresentable rather than merely rejected.
   */
  password?: { hash: string; at: Date }
  status?: AccountStatus
  locale?: string
}

export async function insertUser(db: DbHandle, input: NewUser): Promise<UserRow> {
  const rows = await db
    .insert(users)
    .values({
      id: input.id ?? newId(),
      phoneEncrypted: input.phone.encrypted,
      phoneHash: input.phone.hash,
      phoneMasked: input.phone.masked,
      phoneVerifiedAt: input.phone.verifiedAt ?? null,
      emailEncrypted: input.email?.encrypted ?? null,
      emailHash: input.email?.hash ?? null,
      emailMasked: input.email?.masked ?? null,
      emailVerifiedAt: input.email?.verifiedAt ?? null,
      fullName: input.fullName ?? null,
      passwordHash: input.password?.hash ?? null,
      passwordUpdatedAt: input.password?.at ?? null,
      ...(input.status ? { status: input.status } : {}),
      ...(input.locale ? { locale: input.locale } : {}),
    })
    .returning()

  return inserted(rows, 'insertUser')
}

export interface UserPatch {
  fullName?: string | null
  locale?: string
  status?: AccountStatus
  /** `null` clears all three email columns together. */
  email?: { encrypted: string; hash: string; masked: string } | null
  emailVerifiedAt?: Date | null
  phoneVerifiedAt?: Date | null
}

/**
 * Update the mutable, non-credential parts of a user.
 *
 * Password, login bookkeeping and account status changes that carry consequences have
 * their own functions below, so that "change your display name" and "change the thing
 * that lets you sign in" are not the same call site.
 */
export async function updateUser(
  db: DbHandle,
  userId: string,
  patch: UserPatch,
): Promise<UserRow | null> {
  const set: Record<string, unknown> = {}
  if (patch.fullName !== undefined) set.fullName = patch.fullName
  if (patch.locale !== undefined) set.locale = patch.locale
  if (patch.status !== undefined) set.status = patch.status
  if (patch.emailVerifiedAt !== undefined) set.emailVerifiedAt = patch.emailVerifiedAt
  if (patch.phoneVerifiedAt !== undefined) set.phoneVerifiedAt = patch.phoneVerifiedAt
  if (patch.email !== undefined) {
    set.emailEncrypted = patch.email?.encrypted ?? null
    set.emailHash = patch.email?.hash ?? null
    set.emailMasked = patch.email?.masked ?? null
    // A new address has not been verified, and clearing one cannot leave a
    // verification timestamp behind.
    if (patch.emailVerifiedAt === undefined) set.emailVerifiedAt = null
  }

  // An empty patch is a caller bug, not an excuse to issue `SET` with nothing in it —
  // which drizzle would reject at runtime with a much less helpful message.
  if (Object.keys(set).length === 0) throw new Error('updateUser: nothing to update')

  return one(
    await db
      .update(users)
      .set(set)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning(),
  )
}

/**
 * Set or replace a password.
 *
 * Revoking the user's other sessions afterwards is the caller's job (§45): it needs an
 * audit row per revoked session, which is a decision, not a query.
 */
export async function setPassword(
  db: DbHandle,
  input: { userId: string; passwordHash: string; now: Date },
): Promise<UserRow | null> {
  return one(
    await db
      .update(users)
      .set({ passwordHash: input.passwordHash, passwordUpdatedAt: input.now })
      .where(and(eq(users.id, input.userId), isNull(users.deletedAt)))
      .returning(),
  )
}

export async function markPhoneVerified(
  db: DbHandle,
  input: { userId: string; now: Date },
): Promise<UserRow | null> {
  return one(
    await db
      .update(users)
      .set({ phoneVerifiedAt: input.now })
      .where(and(eq(users.id, input.userId), isNull(users.deletedAt)))
      .returning(),
  )
}

/**
 * Record a successful sign-in.
 *
 * `last_ip_hash` is hashed by `hashIp()` before it arrives: useful for correlating a
 * takeover, useless for following someone around.
 */
export async function recordSuccessfulLogin(
  db: DbHandle,
  input: { userId: string; now: Date; ipHash?: string | null },
): Promise<UserRow | null> {
  return one(
    await db
      .update(users)
      .set({ lastLoginAt: input.now, lastIpHash: input.ipHash ?? null })
      .where(and(eq(users.id, input.userId), isNull(users.deletedAt)))
      .returning(),
  )
}

export async function setAccountStatus(
  db: DbHandle,
  input: { userId: string; status: AccountStatus },
): Promise<UserRow | null> {
  return one(
    await db
      .update(users)
      .set({ status: input.status })
      .where(and(eq(users.id, input.userId), isNull(users.deletedAt)))
      .returning(),
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Roles
// ═══════════════════════════════════════════════════════════════════════════

export interface RoleGrant {
  /** The `user_roles` row, so a revocation can name exactly what it revoked. */
  id: string
  role: UserRole
  /** Set for `shop_owner` and `shop_staff`, null for every other role. */
  shopId: string | null
  grantedAt: Date
}

/**
 * Every non-revoked grant a user holds.
 *
 * This is the only source for `AuthContext.roles` and `AuthContext.shopIds`. Neither
 * is ever read from the request or from the session row alone, so revoking a staff
 * member's access takes effect on their next request rather than at their next
 * sign-in.
 */
export async function activeRoles(db: DbHandle, userId: string): Promise<RoleGrant[]> {
  return db
    .select({
      id: userRoles.id,
      role: userRoles.role,
      shopId: userRoles.shopId,
      grantedAt: userRoles.grantedAt,
    })
    .from(userRoles)
    .where(and(eq(userRoles.userId, userId), isNull(userRoles.revokedAt)))
    .orderBy(userRoles.grantedAt)
}

/**
 * Find one active grant.
 *
 * `shopId: null` means "the unscoped grant", not "any scope" — a shop-scoped role and
 * an unscoped one are different rows and `user_roles_scope_matches_role` keeps them
 * from being confused.
 */
export async function findActiveRole(
  db: DbHandle,
  input: { userId: string; role: UserRole; shopId?: string | null },
): Promise<UserRoleRow | null> {
  const shopId = input.shopId ?? null
  return one(
    await db
      .select()
      .from(userRoles)
      .where(
        and(
          eq(userRoles.userId, input.userId),
          eq(userRoles.role, input.role),
          shopId === null ? isNull(userRoles.shopId) : eq(userRoles.shopId, shopId),
          isNull(userRoles.revokedAt),
        ),
      )
      .limit(1),
  )
}

export async function grantRole(
  db: DbHandle,
  input: {
    userId: string
    role: UserRole
    shopId?: string | null
    grantedBy?: string | null
    now?: Date
  },
): Promise<UserRoleRow> {
  const rows = await db
    .insert(userRoles)
    .values({
      id: newId(),
      userId: input.userId,
      role: input.role,
      shopId: input.shopId ?? null,
      grantedBy: input.grantedBy ?? null,
      ...(input.now ? { grantedAt: input.now } : {}),
    })
    .returning()

  return inserted(rows, 'grantRole')
}

/**
 * Revoke a grant.
 *
 * A revocation is an event, not a deletion: the row stays, `revoked_at` is set, and
 * `user_roles_active_key` — partial on `revoked_at IS NULL` — lets the same role be
 * granted again later without a conflict. `null` means it was already revoked.
 */
export async function revokeRole(
  db: DbHandle,
  input: { roleId: string; revokedBy?: string | null; reason?: string | null; now: Date },
): Promise<UserRoleRow | null> {
  return one(
    await db
      .update(userRoles)
      .set({
        revokedAt: input.now,
        revokedBy: input.revokedBy ?? null,
        revokeReason: input.reason ?? null,
      })
      .where(and(eq(userRoles.id, input.roleId), isNull(userRoles.revokedAt)))
      .returning(),
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// OTP challenges
// ═══════════════════════════════════════════════════════════════════════════

export interface NewOtpChallenge {
  id?: string
  purpose: OtpPurpose
  /** `hashIdentifier()` of the phone or email. The destination itself is not stored. */
  destinationHash: string
  channel: NotificationChannel
  codeHash: string
  expiresAt: Date
  maxAttempts?: number
  requestedIpHash?: string | null
}

export async function insertOtpChallenge(
  db: DbHandle,
  input: NewOtpChallenge,
): Promise<OtpChallengeRow> {
  const rows = await db
    .insert(otpChallenges)
    .values({
      id: input.id ?? newId(),
      purpose: input.purpose,
      destinationHash: input.destinationHash,
      channel: input.channel,
      codeHash: input.codeHash,
      expiresAt: input.expiresAt,
      requestedIpHash: input.requestedIpHash ?? null,
      ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
    })
    .returning()

  return inserted(rows, 'insertOtpChallenge')
}

/**
 * The newest challenge for a destination that could still be answered.
 *
 * Matches `otp_lookup_idx` exactly. Newest wins: if two are somehow live, the older
 * one is the one a resend replaced.
 */
export async function findLiveOtpChallenge(
  db: DbHandle,
  input: { destinationHash: string; purpose: OtpPurpose; now: Date },
): Promise<OtpChallengeRow | null> {
  return one(
    await db
      .select()
      .from(otpChallenges)
      .where(
        and(
          eq(otpChallenges.destinationHash, input.destinationHash),
          eq(otpChallenges.purpose, input.purpose),
          isNull(otpChallenges.consumedAt),
          isNull(otpChallenges.lockedAt),
          gt(otpChallenges.expiresAt, input.now),
        ),
      )
      .orderBy(desc(otpChallenges.expiresAt))
      .limit(1),
  )
}

/**
 * The newest challenge for a destination whatever its state.
 *
 * Used for the resend cooldown and for the "you have already been sent a code"
 * response. Deliberately includes consumed and locked rows: the interval since the
 * last *send* is the thing being throttled, and skipping dead rows would let someone
 * reset the cooldown by burning a challenge.
 */
export async function findLatestOtpChallenge(
  db: DbHandle,
  input: { destinationHash: string; purpose: OtpPurpose },
): Promise<OtpChallengeRow | null> {
  return one(
    await db
      .select()
      .from(otpChallenges)
      .where(
        and(
          eq(otpChallenges.destinationHash, input.destinationHash),
          eq(otpChallenges.purpose, input.purpose),
        ),
      )
      .orderBy(desc(otpChallenges.createdAt))
      .limit(1),
  )
}

/**
 * Count one wrong guess, and lock the challenge if that was the last one allowed.
 *
 * One statement, because the two halves must not come apart: incrementing and then
 * separately deciding to lock gives a window in which `max_attempts` concurrent
 * requests each see "one attempt left".
 *
 * `least()` is not decoration. `otp_attempts_bounded` caps `attempts` at
 * `max_attempts`, so a row that somehow reached the cap without being locked would
 * make a bare `attempts + 1` fail with a check violation — turning a wrong OTP into a
 * 500. Clamping keeps the failure a wrong OTP.
 *
 * `null` means the challenge was already consumed or locked, which the caller reports
 * the same way as a wrong code: a challenge that is gone and one that never matched
 * are indistinguishable to whoever is guessing.
 */
export async function recordOtpAttempt(
  db: DbHandle,
  input: { challengeId: string; now: Date },
): Promise<OtpChallengeRow | null> {
  return one(
    await db
      .update(otpChallenges)
      .set({
        attempts: sql`least(${otpChallenges.attempts} + 1, ${otpChallenges.maxAttempts})`,
        lockedAt: sql`case
          when ${otpChallenges.attempts} + 1 >= ${otpChallenges.maxAttempts} then ${asTimestamp(input.now)}
          else ${otpChallenges.lockedAt}
        end`,
      })
      .where(
        and(
          eq(otpChallenges.id, input.challengeId),
          isNull(otpChallenges.consumedAt),
          isNull(otpChallenges.lockedAt),
        ),
      )
      .returning(),
  )
}

/**
 * Mark a challenge used.
 *
 * The single-use guarantee, and the reason it is a conditional update rather than a
 * flag set after a successful comparison: two requests arriving with the same correct
 * code must not both succeed, and only one of them can win an `UPDATE ... WHERE
 * consumed_at IS NULL`. The expiry is re-checked here too, so a code cannot be
 * accepted by a verification that started before it lapsed.
 *
 * `null` means somebody else consumed it, it was locked, or it expired mid-flight.
 * Treat it as a failed verification.
 */
export async function consumeOtpChallenge(
  db: DbHandle,
  input: { challengeId: string; now: Date },
): Promise<OtpChallengeRow | null> {
  return one(
    await db
      .update(otpChallenges)
      .set({ consumedAt: input.now })
      .where(
        and(
          eq(otpChallenges.id, input.challengeId),
          isNull(otpChallenges.consumedAt),
          isNull(otpChallenges.lockedAt),
          gt(otpChallenges.expiresAt, input.now),
        ),
      )
      .returning(),
  )
}

/** Kill a challenge without counting an attempt. Used by admin tools and lockouts. */
export async function lockOtpChallenge(
  db: DbHandle,
  input: { challengeId: string; now: Date },
): Promise<OtpChallengeRow | null> {
  return one(
    await db
      .update(otpChallenges)
      .set({ lockedAt: input.now })
      .where(and(eq(otpChallenges.id, input.challengeId), isNull(otpChallenges.lockedAt)))
      .returning(),
  )
}

/**
 * Issue a new code on an existing challenge.
 *
 * A resend replaces the code and extends the expiry on the *same row*, so `attempts`
 * carries over. That is the point: if a resend created a fresh challenge, five wrong
 * guesses followed by "resend" would reset the attempt budget, and the five-attempt
 * cap would be advisory. `resend_count` is what the cooldown and the abuse report
 * read.
 *
 * `null` means the challenge is consumed or locked and cannot be revived — the caller
 * should start a new one.
 */
export async function resendOtpChallenge(
  db: DbHandle,
  input: { challengeId: string; codeHash: string; expiresAt: Date },
): Promise<OtpChallengeRow | null> {
  return one(
    await db
      .update(otpChallenges)
      .set({
        codeHash: input.codeHash,
        expiresAt: input.expiresAt,
        resendCount: sql`${otpChallenges.resendCount} + 1`,
      })
      .where(
        and(
          eq(otpChallenges.id, input.challengeId),
          isNull(otpChallenges.consumedAt),
          isNull(otpChallenges.lockedAt),
        ),
      )
      .returning(),
  )
}

/**
 * Lock every other live challenge for a destination.
 *
 * Called when a genuinely new challenge is created, so exactly one code is ever
 * answerable for a given phone number and purpose. Without it, an attacker who can
 * make the victim request a second code gets two valid windows to guess in.
 */
export async function supersedeOtpChallenges(
  db: DbHandle,
  input: {
    destinationHash: string
    purpose: OtpPurpose
    now: Date
    exceptChallengeId?: string | null
  },
): Promise<number> {
  const except = input.exceptChallengeId ?? null
  const rows = await db
    .update(otpChallenges)
    .set({ lockedAt: input.now })
    .where(
      and(
        eq(otpChallenges.destinationHash, input.destinationHash),
        eq(otpChallenges.purpose, input.purpose),
        isNull(otpChallenges.consumedAt),
        isNull(otpChallenges.lockedAt),
        except === null ? undefined : sql`${otpChallenges.id} <> ${except}`,
      ),
    )
    .returning({ id: otpChallenges.id })

  return rows.length
}

/**
 * Drop expired challenges. Called by the retention sweeper.
 *
 * Bounded, and deliberately two statements: Postgres has no `DELETE ... LIMIT`, and a
 * sweeper that deletes a million rows in one transaction holds locks for minutes. The
 * caller loops until this returns less than `limit`.
 */
export async function deleteExpiredOtpChallenges(
  db: DbHandle,
  input: { before: Date; limit?: number },
): Promise<number> {
  const doomed = await db
    .select({ id: otpChallenges.id })
    .from(otpChallenges)
    .where(lt(otpChallenges.expiresAt, input.before))
    .limit(input.limit ?? 1_000)

  if (doomed.length === 0) return 0
  await db.delete(otpChallenges).where(
    inArray(
      otpChallenges.id,
      doomed.map((row) => row.id),
    ),
  )
  return doomed.length
}

// ═══════════════════════════════════════════════════════════════════════════
// Sessions
// ═══════════════════════════════════════════════════════════════════════════

export interface NewSession {
  /**
   * Required, not generated. The session token is `<id>.<secret>` — the id has to
   * exist before the token can be minted, which is what makes refresh-token reuse a
   * primary-key lookup instead of a miss (see `tokens.ts`).
   */
  id: string
  userId: string
  tokenHash: string
  refreshTokenHash: string
  surface: Surface
  activeRole: UserRole
  /** Required for the shop surface, forbidden elsewhere: `sessions_shop_scope`. */
  activeShopId?: string | null
  deviceEncrypted?: string | null
  ipHash?: string | null
  mfaSatisfiedAt?: Date | null
  expiresAt: Date
  absoluteExpiresAt: Date
}

export async function insertSession(db: DbHandle, input: NewSession): Promise<SessionRow> {
  const rows = await db
    .insert(sessions)
    .values({
      id: input.id,
      userId: input.userId,
      tokenHash: input.tokenHash,
      refreshTokenHash: input.refreshTokenHash,
      surface: input.surface,
      activeRole: input.activeRole,
      activeShopId: input.activeShopId ?? null,
      deviceEncrypted: input.deviceEncrypted ?? null,
      ipHash: input.ipHash ?? null,
      mfaSatisfiedAt: input.mfaSatisfiedAt ?? null,
      expiresAt: input.expiresAt,
      absoluteExpiresAt: input.absoluteExpiresAt,
    })
    .returning()

  return inserted(rows, 'insertSession')
}

/**
 * Load a session by id.
 *
 * The only way to reach a session, and by design: the caller compares the presented
 * secret against `token_hash` in constant time rather than looking the hash up. That
 * costs nothing and it is what makes a rotated refresh token *findable* — a hash
 * lookup of a rotated token returns nothing, so theft would be indistinguishable from
 * a typo.
 *
 * Revoked and expired sessions are returned. Liveness is a policy decision
 * (`isSessionLive`), and refresh-reuse detection needs to see the revoked row.
 */
export async function findSessionById(db: DbHandle, sessionId: string): Promise<SessionRow | null> {
  return one(await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1))
}

/**
 * Rotate a session's tokens, if and only if the caller has the current generation.
 *
 * The compare-and-swap at the centre of refresh-token reuse detection. `WHERE
 * refresh_generation = <expected>` means two refreshes with the same token cannot both
 * win: the first bumps the generation, the second matches nothing and gets `null`.
 *
 * `null` therefore means one of three things — the session was revoked, it no longer
 * exists, or the presented refresh token belonged to an earlier generation. The last
 * is the interesting one: it is either a stolen token or a client racing itself, and
 * the caller's answer to both is to revoke the whole family (§45). Better to sign a
 * confused client out than to leave a thief holding a live session.
 */
export async function rotateSessionTokens(
  db: DbHandle,
  input: {
    sessionId: string
    expectedGeneration: number
    tokenHash: string
    refreshTokenHash: string
    expiresAt: Date
    now: Date
  },
): Promise<SessionRow | null> {
  return one(
    await db
      .update(sessions)
      .set({
        tokenHash: input.tokenHash,
        refreshTokenHash: input.refreshTokenHash,
        refreshGeneration: sql`${sessions.refreshGeneration} + 1`,
        expiresAt: input.expiresAt,
        lastSeenAt: input.now,
      })
      .where(
        and(
          eq(sessions.id, input.sessionId),
          eq(sessions.refreshGeneration, input.expectedGeneration),
          isNull(sessions.revokedAt),
        ),
      )
      .returning(),
  )
}

/**
 * Slide the idle deadline forward and record the visit.
 *
 * `expiresAt` is computed by `slideExpiry()`, which clamps it to
 * `absolute_expires_at` — so this write cannot extend a session past its ceiling, and
 * `sessions_expiry_ordered` would refuse it if it tried.
 */
export async function touchSession(
  db: DbHandle,
  input: { sessionId: string; now: Date; expiresAt: Date },
): Promise<SessionRow | null> {
  return one(
    await db
      .update(sessions)
      .set({ lastSeenAt: input.now, expiresAt: input.expiresAt })
      .where(and(eq(sessions.id, input.sessionId), isNull(sessions.revokedAt)))
      .returning(),
  )
}

/** Record that a second factor was presented. Read back by `isMfaFresh()`. */
export async function markMfaSatisfied(
  db: DbHandle,
  input: { sessionId: string; now: Date },
): Promise<SessionRow | null> {
  return one(
    await db
      .update(sessions)
      .set({ mfaSatisfiedAt: input.now, lastSeenAt: input.now })
      .where(and(eq(sessions.id, input.sessionId), isNull(sessions.revokedAt)))
      .returning(),
  )
}

/**
 * Point a shop session at a different shop.
 *
 * Only within the shop surface, and only to a shop the user actually holds a role at —
 * which the caller checks against `activeRoles()`, never against the request. Moving
 * between surfaces needs a new session, because the cookie name, the lifetime and the
 * MFA requirement all differ.
 */
export async function switchActiveShop(
  db: DbHandle,
  input: { sessionId: string; activeRole: UserRole; activeShopId: string; now: Date },
): Promise<SessionRow | null> {
  return one(
    await db
      .update(sessions)
      .set({
        activeRole: input.activeRole,
        activeShopId: input.activeShopId,
        lastSeenAt: input.now,
      })
      .where(
        and(
          eq(sessions.id, input.sessionId),
          eq(sessions.surface, 'shop'),
          isNull(sessions.revokedAt),
        ),
      )
      .returning(),
  )
}

export async function revokeSession(
  db: DbHandle,
  input: { sessionId: string; now: Date; reason: string },
): Promise<SessionRow | null> {
  return one(
    await db
      .update(sessions)
      .set({ revokedAt: input.now, revokeReason: input.reason })
      .where(and(eq(sessions.id, input.sessionId), isNull(sessions.revokedAt)))
      .returning(),
  )
}

/**
 * Revoke every live session a user holds, optionally sparing one.
 *
 * What a password change, a suspension and "sign out everywhere" all do. The revoked
 * rows come back so the caller can write an audit row naming each device — a bare
 * count would tell an investigator nothing about what was signed out.
 *
 * `exceptSessionId` spares the session doing the revoking, so changing your password
 * does not sign you out of the tab you changed it in.
 */
export async function revokeSessionsForUser(
  db: DbHandle,
  input: { userId: string; now: Date; reason: string; exceptSessionId?: string | null },
): Promise<SessionRow[]> {
  const except = input.exceptSessionId ?? null
  return db
    .update(sessions)
    .set({ revokedAt: input.now, revokeReason: input.reason })
    .where(
      and(
        eq(sessions.userId, input.userId),
        isNull(sessions.revokedAt),
        except === null ? undefined : sql`${sessions.id} <> ${except}`,
      ),
    )
    .returning()
}

/**
 * The device list in §45. Live sessions only, newest first.
 *
 * `device_encrypted` comes back as ciphertext; decrypting it for display is the
 * caller's job, so a query that only needs to count sessions never touches the key.
 */
export async function listActiveSessions(
  db: DbHandle,
  input: { userId: string; now: Date },
): Promise<SessionRow[]> {
  return db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, input.userId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, input.now),
      ),
    )
    .orderBy(desc(sessions.lastSeenAt))
}

/**
 * Delete sessions that are past their hard ceiling.
 *
 * Keyed on `absolute_expires_at`, not `expires_at`: an idle-expired session is still
 * evidence for a support investigation, and it may still be refreshable. Once the
 * absolute cap has passed there is nothing left to say. Bounded like the OTP sweep.
 */
export async function deleteExpiredSessions(
  db: DbHandle,
  input: { before: Date; limit?: number },
): Promise<number> {
  const doomed = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(lt(sessions.absoluteExpiresAt, input.before))
    .limit(input.limit ?? 1_000)

  if (doomed.length === 0) return 0
  await db.delete(sessions).where(
    inArray(
      sessions.id,
      doomed.map((row) => row.id),
    ),
  )
  return doomed.length
}

// ═══════════════════════════════════════════════════════════════════════════
// TOTP
// ═══════════════════════════════════════════════════════════════════════════

export async function findTotp(db: DbHandle, userId: string): Promise<UserTotpRow | null> {
  return one(await db.select().from(userTotp).where(eq(userTotp.userId, userId)).limit(1))
}

/**
 * `last_used_counter` as `verifyTotp()` wants it.
 *
 * The column is `bigint` because that is what a 64-bit HOTP counter is; the RFC's
 * arithmetic is in `number`. A TOTP step is `unixSeconds / 30`, so the value is around
 * 5.6 × 10⁷ today and will not reach `Number.MAX_SAFE_INTEGER` for longer than the
 * universe has existed. The conversion is safe, and doing it here means the seam
 * exists in exactly one place.
 */
export function lastUsedCounter(row: UserTotpRow): number | null {
  return row.lastUsedCounter === null ? null : Number(row.lastUsedCounter)
}

/**
 * Store a fresh secret and a fresh set of recovery codes.
 *
 * Enrolment resets everything, including `confirmed_at`: a secret nobody has proved
 * they can generate codes from must not leave the account looking protected. It also
 * means this call *destroys* a working second factor, so the caller must have proved
 * the current one first (a password and, where one exists, a current TOTP code).
 * Without that check, a stolen session could quietly re-enrol the victim's MFA.
 */
export async function upsertTotpSecret(
  db: DbHandle,
  input: { userId: string; secretEncrypted: string; recoveryCodeHashes: string[] },
): Promise<UserTotpRow> {
  const rows = await db
    .insert(userTotp)
    .values({
      userId: input.userId,
      secretEncrypted: input.secretEncrypted,
      recoveryCodeHashes: input.recoveryCodeHashes,
    })
    .onConflictDoUpdate({
      target: userTotp.userId,
      set: {
        secretEncrypted: input.secretEncrypted,
        recoveryCodeHashes: input.recoveryCodeHashes,
        recoveryCodesUsed: 0,
        confirmedAt: null,
        lastUsedAt: null,
        lastUsedCounter: null,
      },
    })
    .returning()

  return inserted(rows, 'upsertTotpSecret')
}

/**
 * Finish enrolment: the user has produced a code from the secret.
 *
 * Conditional on `confirmed_at IS NULL`, so confirmation cannot be replayed to reset
 * the counter on an already-live enrolment. The accepted counter is persisted here as
 * well — the confirmation code is a used code and must not work twice.
 */
export async function confirmTotp(
  db: DbHandle,
  input: { userId: string; now: Date; counter: number },
): Promise<UserTotpRow | null> {
  return one(
    await db
      .update(userTotp)
      .set({
        confirmedAt: input.now,
        lastUsedAt: input.now,
        lastUsedCounter: BigInt(input.counter),
      })
      .where(and(eq(userTotp.userId, input.userId), isNull(userTotp.confirmedAt)))
      .returning(),
  )
}

/**
 * Persist an accepted TOTP counter, and refuse if it is not newer.
 *
 * `verifyTotp()` is pure and cannot enforce single use; this write is what does. The
 * `last_used_counter < counter` predicate makes it a compare-and-swap, so two requests
 * carrying the same six digits inside the same 30-second step cannot both succeed —
 * which is exactly the shoulder-surfing replay the counter exists to stop.
 *
 * `null` means replay, or that the enrolment is not confirmed. Either way the code is
 * not accepted, whatever `verifyTotp()` said about the digits.
 */
export async function recordTotpUse(
  db: DbHandle,
  input: { userId: string; now: Date; counter: number },
): Promise<UserTotpRow | null> {
  const counter = BigInt(input.counter)
  return one(
    await db
      .update(userTotp)
      .set({ lastUsedAt: input.now, lastUsedCounter: counter })
      .where(
        and(
          eq(userTotp.userId, input.userId),
          sql`${userTotp.confirmedAt} is not null`,
          or(isNull(userTotp.lastUsedCounter), lt(userTotp.lastUsedCounter, counter)),
        ),
      )
      .returning(),
  )
}

/**
 * Spend one recovery code.
 *
 * `array_remove` in the `SET` and `= any(...)` in the `WHERE` make this single-use in
 * one statement: the row only matches while the hash is still in the array, so two
 * requests presenting the same code cannot both come back with a row.
 *
 * `null` means the code is not (or is no longer) valid for this user.
 */
export async function consumeRecoveryCode(
  db: DbHandle,
  input: { userId: string; codeHash: string; now: Date },
): Promise<UserTotpRow | null> {
  return one(
    await db
      .update(userTotp)
      .set({
        recoveryCodeHashes: sql`array_remove(${userTotp.recoveryCodeHashes}, ${input.codeHash})`,
        recoveryCodesUsed: sql`${userTotp.recoveryCodesUsed} + 1`,
        lastUsedAt: input.now,
      })
      .where(
        and(
          eq(userTotp.userId, input.userId),
          sql`${input.codeHash} = any(${userTotp.recoveryCodeHashes})`,
        ),
      )
      .returning(),
  )
}

/**
 * Remove a second factor entirely.
 *
 * The admin MFA reset (`auth.mfa.reset`, critical, reason required). It is the most
 * dangerous call in this file — it turns an account protected by something the owner
 * has into one protected by a password — so the capability that reaches it is
 * `conditional` for every role and the audit row is not optional.
 */
export async function deleteTotp(db: DbHandle, userId: string): Promise<boolean> {
  const rows = await db
    .delete(userTotp)
    .where(eq(userTotp.userId, userId))
    .returning({ userId: userTotp.userId })
  return rows.length > 0
}

// ═══════════════════════════════════════════════════════════════════════════
// Login attempts
// ═══════════════════════════════════════════════════════════════════════════

export interface NewLoginAttempt {
  id?: string
  /** Null when the identifier matched no account: there is nobody to attribute it to. */
  userId?: string | null
  identifierHash: string
  surface: Surface
  method: LoginMethod
  outcome: LoginOutcome
  /** A short machine-readable reason. Never the credential, never the identifier. */
  failureReason?: string | null
  ipHash?: string | null
  userAgentFamily?: string | null
}

/**
 * Append one attempt.
 *
 * Written for *every* outcome including the successful ones, because a timeline with
 * only failures cannot answer the question an investigator actually has: did they get
 * in. Append-only by trigger (migration 0010) — there is no update path.
 */
export async function insertLoginAttempt(
  db: DbHandle,
  input: NewLoginAttempt,
): Promise<LoginAttemptRow> {
  const rows = await db
    .insert(loginAttempts)
    .values({
      id: input.id ?? newId(),
      userId: input.userId ?? null,
      identifierHash: input.identifierHash,
      surface: input.surface,
      method: input.method,
      outcome: input.outcome,
      failureReason: input.failureReason ?? null,
      ipHash: input.ipHash ?? null,
      userAgentFamily: input.userAgentFamily ?? null,
    })
    .returning()

  return inserted(rows, 'insertLoginAttempt')
}

/**
 * How many times this identifier has failed since it last succeeded.
 *
 * "Since the last success" rather than "in the last window", which is the difference
 * between a lockout that means something and one that punishes a person for mistyping
 * their password once a month for five months. A successful sign-in resets the count
 * without any write of its own.
 *
 * `since` bounds the scan so the lockout cannot be triggered by ancient history and so
 * the query stays on `login_attempts_identifier_idx`.
 */
export async function failuresSinceLastSuccess(
  db: DbHandle,
  input: { identifierHash: string; since: Date },
): Promise<number> {
  const lastSuccess = one(
    await db
      .select({ createdAt: loginAttempts.createdAt })
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.identifierHash, input.identifierHash),
          eq(loginAttempts.outcome, 'success'),
          gt(loginAttempts.createdAt, input.since),
        ),
      )
      .orderBy(desc(loginAttempts.createdAt))
      .limit(1),
  )

  const from = lastSuccess ? lastSuccess.createdAt : input.since

  const counted = one(
    await db
      .select({ total: sql<string>`count(*)` })
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.identifierHash, input.identifierHash),
          // `throttled` is not a failed credential — it is us refusing to check one —
          // so counting it would let a rate limit escalate itself into a lockout.
          inArray(loginAttempts.outcome, ['failure', 'locked']),
          gt(loginAttempts.createdAt, from),
        ),
      ),
  )

  // `count(*)` arrives as a string: it is `int8`, and the driver is configured not to
  // narrow those silently.
  return Number(counted?.total ?? 0)
}

/** The security timeline for one account, newest first. Read by the admin console. */
export async function listRecentAttempts(
  db: DbHandle,
  input: { userId: string; limit?: number },
): Promise<LoginAttemptRow[]> {
  return db
    .select()
    .from(loginAttempts)
    .where(eq(loginAttempts.userId, input.userId))
    .orderBy(desc(loginAttempts.createdAt))
    .limit(input.limit ?? 50)
}
