import { describe, expect, it } from 'vitest'

import { isAppError } from './errors'
import {
  createMemoryLimiter,
  createNoopLimiter,
  createRedisLimiter,
  enforceRateLimit,
  enforceRateLimits,
  RATE_LIMIT_RULES,
  type RateLimiter,
  type RateLimitRuleName,
} from './rate-limit'
import type { RedisLike } from './redis'

/**
 * The property worth testing here is not "does it count".
 *
 * It is the fallback. Every rule declares what happens when Redis is unreachable, and
 * getting one inverted means either an open door on the endpoints that spend money or a
 * total sign-in outage on the ones a database counter already protects. After that, the
 * only other thing that must hold is that a subject never reaches a Redis key in the
 * clear — a rate-limit key is often a phone number, frequently one belonging to someone
 * who is not a customer at all.
 */

/**
 * A stand-in for the HMAC blind index, so these tests need no encryption key. Distinct
 * for distinct inputs and not a substring of them, which is all the real one guarantees
 * as far as this module is concerned.
 */
const hashSubject = (subject: string): string => {
  let hash = 7
  for (const character of subject) hash = (hash * 31 + character.charCodeAt(0)) % 0xffff_ffff
  return `h${hash.toString(16)}`
}

interface FakeRedis extends RedisLike {
  keys(): string[]
  entries: Map<string, { value: number; ttlMs: number | null }>
}

/** A Redis that behaves, so the counting can be checked exactly. */
function fakeRedis(): FakeRedis {
  const entries = new Map<string, { value: number; ttlMs: number | null }>()

  return {
    entries,
    keys: () => [...entries.keys()],
    async incr(key) {
      const existing = entries.get(key)
      const next = (existing?.value ?? 0) + 1
      entries.set(key, { value: next, ttlMs: existing?.ttlMs ?? null })
      return next
    },
    async pexpire(key, milliseconds) {
      const existing = entries.get(key)
      if (!existing) return 0
      entries.set(key, { ...existing, ttlMs: milliseconds })
      return 1
    },
    async pttl(key) {
      const existing = entries.get(key)
      // -2 is "no such key"; -1 is "exists, no expiry set".
      if (!existing) return -2
      return existing.ttlMs ?? -1
    },
    async get(key) {
      const existing = entries.get(key)
      return existing ? String(existing.value) : null
    },
    async set() {
      return 'OK'
    },
    async del(...keys) {
      let removed = 0
      for (const key of keys) if (entries.delete(key)) removed += 1
      return removed
    },
    async ping() {
      return 'PONG'
    },
  }
}

/** A Redis that is down. Every command rejects, as `enableOfflineQueue: false` gives. */
function brokenRedis(): RedisLike {
  const fail = async (): Promise<never> => {
    throw new Error('Stream isn’t writeable and enableOfflineQueue options is false')
  }
  return { incr: fail, pexpire: fail, pttl: fail, get: fail, set: fail, del: fail, ping: fail }
}

async function exhaust(limiter: RateLimiter, rule: RateLimitRuleName, subject: string): Promise<void> {
  for (let attempt = 0; attempt < RATE_LIMIT_RULES[rule].limit; attempt += 1) {
    await limiter.check(rule, subject)
  }
}

/** Run something that must reject, and hand back what it rejected with. */
async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw, and it did not')
}

describe('RATE_LIMIT_RULES', () => {
  it('makes every rule declare what happens when Redis is down', () => {
    // The whole point of the table. A rule added without answering this is a rule that
    // will fail open or fail closed by accident.
    for (const [name, rule] of Object.entries(RATE_LIMIT_RULES)) {
      expect(['allow', 'deny'], name).toContain(rule.onUnavailable)
      expect(rule.limit, name).toBeGreaterThan(0)
      expect(rule.windowSeconds, name).toBeGreaterThan(0)
      expect(rule.why.length, name).toBeGreaterThan(10)
    }
  })

  it('fails closed on everything that spends money or reaches a person', () => {
    // Uncounted, an OTP send is a machine SMS-bombing a phone number at our expense,
    // and there is no second line of defence behind it.
    for (const name of [
      'otp.request.phone',
      'otp.request.ip',
      'password.reset.identifier',
      'order.checkout.user',
      'support.contact.user',
      'privacy.export.user',
    ] as const) {
      expect(RATE_LIMIT_RULES[name].onUnavailable, name).toBe('deny')
    }
  })

  it('fails open where a database counter is the real cap', () => {
    // Verification is capped at five attempts on the challenge row, login by account
    // lockout, pickup by the per-order counter. Failing closed here would lock out
    // every shop to protect something that is already protected.
    for (const name of [
      'otp.verify.destination',
      'password.login.identifier',
      'pickup.verify.shop',
      'upload.presign.user',
      'discovery.search.ip',
    ] as const) {
      expect(RATE_LIMIT_RULES[name].onUnavailable, name).toBe('allow')
    }
  })

  it('keeps the OTP limits the auth flow was specified with', () => {
    expect(RATE_LIMIT_RULES['otp.request.phone']).toMatchObject({ limit: 3, windowSeconds: 600 })
    expect(RATE_LIMIT_RULES['otp.request.ip']).toMatchObject({ limit: 20, windowSeconds: 3600 })
  })

  it('limits a phone number harder than an origin', () => {
    // An office or a hostel behind one NAT address is many legitimate customers; one
    // phone number is one person.
    expect(RATE_LIMIT_RULES['otp.request.phone'].limit).toBeLessThan(
      RATE_LIMIT_RULES['otp.request.ip'].limit,
    )
  })
})

describe('createMemoryLimiter', () => {
  it('counts down and then refuses', async () => {
    const limiter = createMemoryLimiter({ hashSubject })

    const first = await limiter.check('otp.request.phone', '+919876543210')
    expect(first).toMatchObject({ allowed: true, limit: 3, remaining: 2, degraded: false })
    // Inside the limit there is nothing to wait for.
    expect(first.retryAfterSeconds).toBe(0)

    await limiter.check('otp.request.phone', '+919876543210')
    expect(await limiter.check('otp.request.phone', '+919876543210')).toMatchObject({
      allowed: true,
      remaining: 0,
    })

    const fourth = await limiter.check('otp.request.phone', '+919876543210')
    expect(fourth.allowed).toBe(false)
    // Never zero: a client told to retry after zero seconds retries immediately.
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('counts each subject separately', async () => {
    const limiter = createMemoryLimiter({ hashSubject })
    await exhaust(limiter, 'otp.request.phone', '+919876543210')

    expect((await limiter.check('otp.request.phone', '+919876543210')).allowed).toBe(false)
    expect((await limiter.check('otp.request.phone', '+919000000001')).allowed).toBe(true)
  })

  it('counts each rule separately, so raising one does not leak into another', async () => {
    const limiter = createMemoryLimiter({ hashSubject })
    await exhaust(limiter, 'otp.request.phone', '+919876543210')
    expect((await limiter.check('otp.verify.destination', '+919876543210')).allowed).toBe(true)
  })

  it('forgets a subject on reset', async () => {
    // What a successful sign-in does, so five wrong guesses followed by the right one
    // does not leave the person one attempt from a lockout.
    const limiter = createMemoryLimiter({ hashSubject })
    await exhaust(limiter, 'otp.request.phone', '+919876543210')
    expect((await limiter.check('otp.request.phone', '+919876543210')).allowed).toBe(false)

    await limiter.reset('otp.request.phone', '+919876543210')
    expect((await limiter.check('otp.request.phone', '+919876543210')).allowed).toBe(true)
  })

  it('honours an operator override in both directions', async () => {
    const limiter = createMemoryLimiter({ hashSubject })
    const tightened = { limit: 1 }

    expect((await limiter.check('discovery.search.ip', '1.2.3.4', tightened)).allowed).toBe(true)
    expect((await limiter.check('discovery.search.ip', '1.2.3.4', tightened)).allowed).toBe(false)

    // Same subject, raised ceiling: the count carries over, the limit moves.
    expect(await limiter.check('discovery.search.ip', '1.2.3.4', { limit: 10 })).toMatchObject({
      allowed: true,
      limit: 10,
    })
  })

  it('never reports negative headroom', async () => {
    const limiter = createMemoryLimiter({ hashSubject })
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect((await limiter.check('otp.request.phone', '+919876543210')).remaining).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('createRedisLimiter', () => {
  it('sets the expiry on the first attempt and not again', async () => {
    const redis = fakeRedis()
    const limiter = createRedisLimiter(redis, { hashSubject })

    const first = await limiter.check('otp.request.phone', '+919876543210')
    expect(first).toMatchObject({ allowed: true, remaining: 2, degraded: false })
    // The window starts at the first request rather than on an aligned bucket, so a
    // subject cannot straddle two windows by waiting for the clock.
    expect([...redis.entries.values()][0]?.ttlMs).toBe(600_000)

    const second = await limiter.check('otp.request.phone', '+919876543210')
    expect(second).toMatchObject({ allowed: true, remaining: 1, retryAfterSeconds: 0 })
  })

  it('repairs a counter that lost its expiry', async () => {
    // The narrow window between INCR and PEXPIRE. Without the repair, a crash there
    // leaves a subject rate-limited forever — a permanent lockout caused by a blip.
    const redis = fakeRedis()
    const limiter = createRedisLimiter(redis, { hashSubject })
    const key = `rl:v1:otp.request.phone:${hashSubject('+919876543210')}`

    await redis.incr(key)
    expect(await redis.pttl(key)).toBe(-1)

    await limiter.check('otp.request.phone', '+919876543210')
    expect(await redis.pttl(key)).toBe(600_000)
  })

  it('never puts the subject in the key', async () => {
    // Redis is not an encrypted store and is not swept by the retention worker. A dump
    // of it must not be a list of phone numbers, including numbers of people who never
    // signed up.
    const redis = fakeRedis()
    const limiter = createRedisLimiter(redis, { hashSubject })

    await limiter.check('otp.request.phone', '+919876543210')
    const keys = redis.keys()
    expect(keys).toHaveLength(1)
    expect(keys[0]).not.toContain('9876543210')
    // The rule name stays readable, so an operator can see what is being counted.
    expect(keys[0]).toContain('otp.request.phone')
  })

  it('refuses when Redis is down and the rule says deny', async () => {
    const limiter = createRedisLimiter(brokenRedis(), { hashSubject })
    const decision = await limiter.check('otp.request.phone', '+919876543210')

    expect(decision).toMatchObject({ allowed: false, degraded: true, remaining: 0 })
    // Bounded at a minute: outages are usually seconds, and a ten-minute Retry-After
    // for a cache that blinked is worse than letting them try again.
    expect(decision.retryAfterSeconds).toBeGreaterThan(0)
    expect(decision.retryAfterSeconds).toBeLessThanOrEqual(60)
  })

  it('allows when Redis is down and the rule says allow', async () => {
    const limiter = createRedisLimiter(brokenRedis(), { hashSubject })
    expect(await limiter.check('password.login.identifier', 'owner@example.com')).toMatchObject({
      allowed: true,
      degraded: true,
      retryAfterSeconds: 0,
    })
  })

  it('does not fail a reset that could not reach Redis', async () => {
    // Reset runs after a successful sign-in. Failing the sign-in because the cleanup
    // after it failed would be absurd, and the counter expires on its own anyway.
    const limiter = createRedisLimiter(brokenRedis(), { hashSubject })
    await limiter.reset('password.login.identifier', 'owner@example.com')
  })
})

describe('createNoopLimiter', () => {
  it('allows everything and reports full headroom', async () => {
    const limiter = createNoopLimiter()
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(await limiter.check('otp.request.phone', '+919876543210')).toMatchObject({
        allowed: true,
        remaining: 3,
        degraded: false,
      })
    }
  })
})

describe('enforceRateLimit', () => {
  it('returns the decision while there is headroom', async () => {
    const limiter = createMemoryLimiter({ hashSubject })
    expect((await enforceRateLimit(limiter, 'otp.request.phone', '+919876543210')).allowed).toBe(true)
  })

  it('throws a 429 carrying Retry-After', async () => {
    const limiter = createMemoryLimiter({ hashSubject })
    await exhaust(limiter, 'otp.request.phone', '+919876543210')

    const thrown = await capture(() => enforceRateLimit(limiter, 'otp.request.phone', '+919876543210'))
    expect(isAppError(thrown)).toBe(true)
    if (!isAppError(thrown)) return

    expect(thrown.code).toBe('rate_limited')
    expect(thrown.status).toBe(429)
    expect(thrown.retryAfterSeconds ?? 0).toBeGreaterThan(0)
  })

  it('does not say which limit was hit', async () => {
    // Telling an attacker they have exhausted the per-phone budget but not the per-IP
    // one is free reconnaissance.
    const limiter = createMemoryLimiter({ hashSubject })
    await exhaust(limiter, 'otp.request.phone', '+919876543210')

    const thrown = await capture(() => enforceRateLimit(limiter, 'otp.request.phone', '+919876543210'))
    if (!isAppError(thrown)) throw thrown

    expect(thrown.message).not.toContain('phone')
    expect(thrown.message).not.toContain('otp')
    expect(thrown.message.toLowerCase()).toContain('too many attempts')
  })

  it('says something honest when the limiter itself is degraded', async () => {
    // "Too many attempts" would be a lie: nobody counted anything.
    const limiter = createRedisLimiter(brokenRedis(), { hashSubject })
    const thrown = await capture(() => enforceRateLimit(limiter, 'otp.request.phone', '+919876543210'))
    if (!isAppError(thrown)) throw thrown

    expect(thrown.message).not.toContain('Too many')
    expect(thrown.message).toContain('try again')
  })
})

describe('enforceRateLimits', () => {
  const otpChecks = [
    { rule: 'otp.request.phone', subject: '+919876543210' },
    { rule: 'otp.request.ip', subject: '203.0.113.4' },
  ] as const

  it('passes when every dimension has headroom', async () => {
    const limiter = createMemoryLimiter({ hashSubject })
    await enforceRateLimits(limiter, [...otpChecks])
  })

  it('throws when any one dimension is exhausted', async () => {
    const limiter = createMemoryLimiter({ hashSubject })
    await exhaust(limiter, 'otp.request.ip', '203.0.113.4')

    const thrown = await capture(() => enforceRateLimits(limiter, [...otpChecks]))
    expect(isAppError(thrown) && thrown.code).toBe('rate_limited')
  })

  it('counts every dimension even once one has failed', async () => {
    // Otherwise tripping the cheap per-phone limit first is a way to keep the per-IP
    // budget untouched while enumerating numbers.
    const limiter = createMemoryLimiter({ hashSubject })
    await exhaust(limiter, 'otp.request.phone', '+919876543210')

    await limiter.check('otp.request.ip', '203.0.113.4')
    const before = await limiter.check('otp.request.ip', '203.0.113.4')

    await capture(() => enforceRateLimits(limiter, [...otpChecks]))

    const after = await limiter.check('otp.request.ip', '203.0.113.4')
    // One for the enforced check, one for this one — so strictly more than one apart.
    expect(after.remaining).toBeLessThan(before.remaining - 1)
  })

  it('reports the longest wait of the limits that fired', async () => {
    // A client that obeys Retry-After must not come straight back into a limit that is
    // still closed.
    const limiter = createMemoryLimiter({ hashSubject })
    await exhaust(limiter, 'otp.request.phone', '+919876543210')
    await exhaust(limiter, 'otp.request.ip', '203.0.113.4')

    const thrown = await capture(() => enforceRateLimits(limiter, [...otpChecks]))
    if (!isAppError(thrown)) throw thrown

    // The hour-long IP window, not the ten-minute phone one.
    expect(thrown.retryAfterSeconds ?? 0).toBeGreaterThan(600)
  })
})
