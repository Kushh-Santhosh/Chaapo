/**
 * Rate limiting.
 *
 * Two things are worth being explicit about, because both are easy to get wrong in a
 * way that only shows up on a bad day.
 *
 * **What the window is.** This is a fixed counter whose window starts at the first
 * request, not an aligned bucket and not a token bucket. `INCR` returns 1 → set the
 * TTL; every later `INCR` inside the window just counts. The known weakness of a fixed
 * window is a burst across the boundary (up to `2 × limit` over `2 × window`), and it
 * is accepted here deliberately: the alternative needs a Lua script or a sorted set per
 * subject, and for every rule below the limit is small and the window is long, so the
 * boundary burst is bounded by something a human could do by hand anyway. Where a burst
 * genuinely must not happen, the guard is a database counter, not this.
 *
 * **What happens when Redis is down.** This is the decision that matters. A limiter
 * that fails open turns a Redis blip into an open door; a limiter that fails closed
 * turns a Redis blip into a total outage. Neither is right for every rule, so each rule
 * declares its own `onUnavailable`:
 *
 *   • `deny` — for anything that spends money or reaches a real person on the first
 *     call. An OTP send is the archetype: uncounted, it is a machine SMS-bombing a
 *     phone number that may not even belong to a customer, at our expense, and there is
 *     no second line of defence downstream. Better that sign-in is briefly unavailable.
 *   • `allow` — for anything where a database counter is the real correctness boundary.
 *     OTP *verification* is capped at five attempts on the `otp_challenges` row; login
 *     is capped by `login_attempts` and account lockout; a pickup code is capped per
 *     order. For these the limiter is a cost and noise control in front of a guard that
 *     still holds, so failing closed would lock out every shop to protect a counter
 *     that is already protected.
 *
 * Subjects are hashed before they become keys. A rate-limit key is frequently a phone
 * number, and frequently a phone number belonging to someone who is *not* a customer —
 * so Redis, which is not an encrypted store and is not covered by the retention
 * sweeper, must never hold one in the clear.
 */

import { errors } from './errors'
import { logger } from './logger'
import { hashIdentifier } from './pii'
import type { RedisLike } from './redis'

// ── Rules ───────────────────────────────────────────────────────────────────

export interface RateLimitRule {
  /** How many attempts are allowed inside the window. */
  limit: number
  windowSeconds: number
  onUnavailable: 'allow' | 'deny'
  /**
   * Why this rule exists, in one line. Shown on the admin console's rate-limit page
   * and quoted in the log line when a limit fires, so the person reading an alert at
   * 2 a.m. does not have to guess whether tripping it is bad.
   */
  why: string
}

/**
 * Every limited action, named once.
 *
 * A table rather than numbers at call sites: the limits are the kind of thing an
 * operator asks to change during a pilot, and they need to be reviewable in one place
 * next to each other. The names are `<area>.<action>.<dimension>` so a rule and the
 * thing it is keyed on cannot drift apart.
 */
export const RATE_LIMIT_RULES = {
  // ── OTP ───────────────────────────────────────────────────────────────────
  'otp.request.phone': {
    limit: 3,
    windowSeconds: 10 * 60,
    // Each one is an SMS we pay for, delivered to a phone the requester may not own.
    onUnavailable: 'deny',
    why: 'Sending OTPs costs money and reaches a real phone (FR-003).',
  },
  'otp.request.ip': {
    limit: 20,
    windowSeconds: 60 * 60,
    onUnavailable: 'deny',
    why: 'One origin enumerating phone numbers to send SMS at our expense.',
  },
  'otp.verify.destination': {
    limit: 12,
    windowSeconds: 10 * 60,
    // `otp_challenges.attempts` locks the challenge after five tries; this only stops
    // someone churning through fresh challenges.
    onUnavailable: 'allow',
    why: 'Guessing an OTP. The five-attempt challenge lockout is the real cap.',
  },
  'otp.verify.ip': {
    limit: 60,
    windowSeconds: 10 * 60,
    onUnavailable: 'allow',
    why: 'One origin guessing codes across many phone numbers.',
  },

  // ── Password ──────────────────────────────────────────────────────────────
  'password.login.identifier': {
    limit: 10,
    windowSeconds: 15 * 60,
    // `login_attempts` plus account lockout is what actually stops a credential
    // stuffer; this keeps scrypt from becoming the attack.
    onUnavailable: 'allow',
    why: 'Guessing a shop password. Account lockout is the real cap.',
  },
  'password.login.ip': {
    limit: 50,
    windowSeconds: 15 * 60,
    onUnavailable: 'allow',
    why: 'One origin stuffing credentials across many accounts.',
  },
  'password.reset.identifier': {
    limit: 3,
    windowSeconds: 60 * 60,
    // Each one emails a real person, and an unlimited reset endpoint is a mail bomb
    // with our domain on it.
    onUnavailable: 'deny',
    why: 'Password-reset mail reaches a real inbox and costs reputation.',
  },
  'totp.verify.user': {
    limit: 10,
    windowSeconds: 5 * 60,
    // Six digits with a ±1-step window is 3 in a million per guess; `last_used_counter`
    // stops replay. This stops a patient script.
    onUnavailable: 'allow',
    why: 'Brute-forcing a six-digit TOTP code.',
  },

  // ── Sessions ──────────────────────────────────────────────────────────────
  'session.refresh.session': {
    limit: 60,
    windowSeconds: 60 * 60,
    onUnavailable: 'allow',
    why: 'A client stuck in a refresh loop. Reuse detection handles theft.',
  },

  // ── Files and orders ──────────────────────────────────────────────────────
  'upload.presign.user': {
    limit: 120,
    windowSeconds: 10 * 60,
    // A presign grants nothing on its own; the per-order file count and size caps are
    // enforced in the database. Failing closed here would break a 40-file job.
    onUnavailable: 'allow',
    why: 'Churning presigned URLs. Per-order file and size caps are the real limit.',
  },
  'order.checkout.user': {
    limit: 20,
    windowSeconds: 10 * 60,
    // Each one creates an order at the payment aggregator. Idempotency keys collapse
    // retries of the *same* checkout; nothing collapses a loop of different ones.
    onUnavailable: 'deny',
    why: 'Each checkout creates a real order at the payment aggregator (FR-401).',
  },
  'pickup.verify.shop': {
    limit: 60,
    windowSeconds: 5 * 60,
    // The per-order attempt counter is the correctness boundary (FR-608). A busy
    // Saturday counter legitimately verifies a lot of pickups.
    onUnavailable: 'allow',
    why: 'Guessing pickup codes. The per-order attempt cap is the real limit.',
  },

  // ── Public surfaces ───────────────────────────────────────────────────────
  'discovery.search.ip': {
    limit: 120,
    windowSeconds: 60,
    onUnavailable: 'allow',
    why: 'Scraping the shop directory. Costs database time, leaks nothing private.',
  },
  'review.create.user': {
    limit: 10,
    windowSeconds: 60 * 60,
    // One review per collected order is enforced by a unique index anyway.
    onUnavailable: 'allow',
    why: 'Review spam. One-per-order is enforced by a unique index.',
  },
  'support.contact.user': {
    limit: 5,
    windowSeconds: 60 * 60,
    onUnavailable: 'deny',
    why: 'Each support message notifies staff.',
  },
  'privacy.export.user': {
    limit: 2,
    windowSeconds: 24 * 60 * 60,
    // An export assembles a bundle of the person's own data and mails a link. Cheap to
    // ask for, expensive to produce.
    onUnavailable: 'deny',
    why: 'A data export builds a file bundle and emails a link (§49).',
  },
} as const satisfies Record<string, RateLimitRule>

export type RateLimitRuleName = keyof typeof RATE_LIMIT_RULES

// ── Decisions ───────────────────────────────────────────────────────────────

export interface RateLimitDecision {
  allowed: boolean
  limit: number
  /** How many attempts are left after this one. Never negative. */
  remaining: number
  /**
   * Seconds until the window resets. Always at least 1 when denied, because a
   * `Retry-After: 0` tells a client to retry immediately and it will.
   */
  retryAfterSeconds: number
  /**
   * True when the backend could not be reached and the rule's `onUnavailable` decided.
   * Surfaced so the caller can log it and the admin console can show that limits are
   * currently being guessed at rather than counted.
   */
  degraded: boolean
}

export interface RateLimiter {
  /**
   * Count one attempt against a rule and say whether it is allowed.
   *
   * `subject` is the thing being limited — a phone number, an IP, a user id, a session
   * id — in the clear. It is hashed inside.
   */
  check(
    rule: RateLimitRuleName,
    subject: string,
    overrides?: Partial<Pick<RateLimitRule, 'limit' | 'windowSeconds'>>,
  ): Promise<RateLimitDecision>
  /** Forget a subject's counter. Used after a successful sign-in and by admin tools. */
  reset(rule: RateLimitRuleName, subject: string): Promise<void>
}

/** How a subject becomes a key component. Injectable so tests need no encryption key. */
export type SubjectHasher = (subject: string) => string

export interface RateLimiterOptions {
  hashSubject?: SubjectHasher
}

const KEY_PREFIX = 'rl:v1'

function keyFor(hash: SubjectHasher, rule: RateLimitRuleName, subject: string): string {
  // The rule name is in the key, so raising a limit does not inherit the old count and
  // two rules keyed on the same phone number cannot share a counter.
  return `${KEY_PREFIX}:${rule}:${hash(subject)}`
}

function resolve(
  rule: RateLimitRuleName,
  overrides?: Partial<Pick<RateLimitRule, 'limit' | 'windowSeconds'>>,
): RateLimitRule {
  const base = RATE_LIMIT_RULES[rule]
  return {
    ...base,
    ...(overrides?.limit !== undefined ? { limit: overrides.limit } : {}),
    ...(overrides?.windowSeconds !== undefined ? { windowSeconds: overrides.windowSeconds } : {}),
  }
}

function allowedDecision(rule: RateLimitRule, count: number, retryAfterSeconds: number): RateLimitDecision {
  const allowed = count <= rule.limit
  return {
    allowed,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - count),
    // A client that is inside the limit has nothing to wait for.
    retryAfterSeconds: allowed ? 0 : Math.max(1, retryAfterSeconds),
    degraded: false,
  }
}

function degradedDecision(rule: RateLimitRule): RateLimitDecision {
  const allowed = rule.onUnavailable === 'allow'
  return {
    allowed,
    limit: rule.limit,
    // Nothing was counted, so reported as exhausted rather than as headroom nobody
    // measured.
    remaining: 0,
    // A minute at most: Redis outages are usually seconds, and telling a shop to come
    // back in ten minutes because a cache blinked is worse than letting them retry.
    retryAfterSeconds: allowed ? 0 : Math.min(rule.windowSeconds, 60),
    degraded: true,
  }
}

// ── Backends ────────────────────────────────────────────────────────────────

/**
 * The in-process limiter.
 *
 * Correct for a single process and therefore correct for `npm run dev` and for tests,
 * and wrong the moment there are two app instances — which is why production uses the
 * Redis one. Kept because a developer without Redis running should still see a 429 when
 * they hammer an endpoint, rather than silently developing against no limits at all.
 */
export function createMemoryLimiter(options: RateLimiterOptions = {}): RateLimiter & {
  /** Test-only: drop every counter. */
  clear(): void
} {
  const hash = options.hashSubject ?? hashIdentifier
  const counters = new Map<string, { count: number; expiresAt: number }>()

  // Swept when it gets large, so a dev server left running overnight against a
  // hammering script does not hold a counter per subject forever.
  const MAX_KEYS = 50_000

  function sweep(now: number): void {
    for (const [key, entry] of counters) {
      if (entry.expiresAt <= now) counters.delete(key)
    }
  }

  return {
    async check(rule, subject, overrides) {
      const effective = resolve(rule, overrides)
      const key = keyFor(hash, rule, subject)
      const now = Date.now()

      if (counters.size >= MAX_KEYS) sweep(now)

      const existing = counters.get(key)
      const entry =
        existing && existing.expiresAt > now
          ? existing
          : { count: 0, expiresAt: now + effective.windowSeconds * 1000 }

      entry.count += 1
      counters.set(key, entry)

      return allowedDecision(effective, entry.count, Math.ceil((entry.expiresAt - now) / 1000))
    },

    async reset(rule, subject) {
      counters.delete(keyFor(hash, rule, subject))
    },

    clear() {
      counters.clear()
    },
  }
}

/**
 * The Redis limiter.
 *
 * `INCR` then, only on the first hit, `PEXPIRE`. Two round trips on the first request
 * of a window and one after that.
 *
 * The TTL is set after the increment rather than before, which leaves a real (if
 * narrow) failure mode: a crash between the two would leave a counter with no
 * expiry — a subject limited forever. So the TTL is also repaired whenever `PTTL`
 * comes back as "no expiry set", which turns a permanent lockout into at most one
 * extra window.
 */
export function createRedisLimiter(redis: RedisLike, options: RateLimiterOptions = {}): RateLimiter {
  const hash = options.hashSubject ?? hashIdentifier

  return {
    async check(rule, subject, overrides) {
      const effective = resolve(rule, overrides)
      const key = keyFor(hash, rule, subject)
      const windowMs = effective.windowSeconds * 1000

      try {
        const count = await redis.incr(key)

        if (count === 1) {
          await redis.pexpire(key, windowMs)
          return allowedDecision(effective, count, effective.windowSeconds)
        }

        const ttl = await redis.pttl(key)
        // -1: the key exists with no expiry. -2: it vanished between the two commands.
        if (ttl < 0) {
          await redis.pexpire(key, windowMs)
          return allowedDecision(effective, count, effective.windowSeconds)
        }

        return allowedDecision(effective, count, Math.ceil(ttl / 1000))
      } catch (error) {
        // Not `error`: Redis being unreachable is already reported by the connection's
        // own handler, and one line per request would bury it.
        logger.warn('rate limiter unavailable', {
          rule,
          fallback: effective.onUnavailable,
          message: error instanceof Error ? error.message : String(error),
        })
        return degradedDecision(effective)
      }
    },

    async reset(rule, subject) {
      try {
        await redis.del(keyFor(hash, rule, subject))
      } catch {
        // A counter that could not be cleared expires on its own. Failing a successful
        // sign-in because the cleanup after it failed would be absurd.
      }
    },
  }
}

/**
 * A limiter that allows everything.
 *
 * Only reachable through `RATE_LIMIT_DISABLED`, which `env.ts` refuses outside
 * development. It exists for the integration suite, where a test that signs in four
 * times would otherwise trip a real limit and fail for a reason unrelated to what it
 * was testing.
 */
export function createNoopLimiter(): RateLimiter {
  return {
    async check(rule) {
      const { limit } = RATE_LIMIT_RULES[rule]
      return { allowed: true, limit, remaining: limit, retryAfterSeconds: 0, degraded: false }
    },
    async reset() {
      // Nothing to reset.
    },
  }
}

// ── Enforcement ─────────────────────────────────────────────────────────────

/**
 * Check a rule and throw if it is exceeded.
 *
 * Throws rather than returning a `Result` because this runs as middleware, before the
 * handler that would have a `Result` to return, and because every call site would do
 * the same thing with a failure. `AppError` carries `retryAfterSeconds`, which the
 * route layer turns into the `Retry-After` header.
 *
 * The message is deliberately vague about *which* limit was hit: telling an attacker
 * that they have exhausted the per-phone budget but not the per-IP one is free
 * reconnaissance.
 */
export async function enforceRateLimit(
  limiter: RateLimiter,
  rule: RateLimitRuleName,
  subject: string,
  overrides?: Partial<Pick<RateLimitRule, 'limit' | 'windowSeconds'>>,
): Promise<RateLimitDecision> {
  const decision = await limiter.check(rule, subject, overrides)
  if (decision.allowed) return decision

  logger.warn('rate limit exceeded', {
    rule,
    why: RATE_LIMIT_RULES[rule].why,
    limit: decision.limit,
    degraded: decision.degraded,
  })

  throw errors.rateLimited(decision.retryAfterSeconds, rateLimitMessage(decision))
}

function rateLimitMessage(decision: RateLimitDecision): string {
  if (decision.degraded) {
    return 'We could not verify this request right now. Please try again in a minute.'
  }
  const minutes = Math.ceil(decision.retryAfterSeconds / 60)
  if (minutes <= 1) return 'Too many attempts. Please try again in a minute.'
  return `Too many attempts. Please try again in about ${minutes} minutes.`
}

/**
 * Check several rules and enforce the strictest outcome.
 *
 * Most endpoints are limited on two dimensions at once — the phone number *and* the
 * origin — and the pair must be evaluated together. Note that every rule is counted
 * even when an earlier one has already failed: skipping the rest would let an attacker
 * keep their per-IP budget untouched by deliberately tripping a per-phone limit first.
 */
export async function enforceRateLimits(
  limiter: RateLimiter,
  checks: Array<{ rule: RateLimitRuleName; subject: string }>,
): Promise<void> {
  const decisions = await Promise.all(
    checks.map(async (check) => ({ ...check, decision: await limiter.check(check.rule, check.subject) })),
  )

  const denied = decisions.filter((entry) => !entry.decision.allowed)
  if (denied.length === 0) return

  // The longest wait, so a client that obeys `Retry-After` does not come straight back
  // into a limit that is still closed.
  const worst = denied.reduce((a, b) =>
    b.decision.retryAfterSeconds > a.decision.retryAfterSeconds ? b : a,
  )

  logger.warn('rate limit exceeded', {
    rule: worst.rule,
    why: RATE_LIMIT_RULES[worst.rule].why,
    rulesTripped: denied.length,
    degraded: worst.decision.degraded,
  })

  throw errors.rateLimited(worst.decision.retryAfterSeconds, rateLimitMessage(worst.decision))
}
