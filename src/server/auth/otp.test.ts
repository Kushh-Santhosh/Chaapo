import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  evaluateOtp,
  generateOtpCode,
  hashOtpCode,
  isWellFormedOtp,
  MAX_RESENDS,
  normaliseOtpInput,
  otpExpiry,
  OTP_CODE_LENGTH,
  resendDecision,
  type Hmac,
  type OtpChallengeState,
} from './otp'

/**
 * The OTP rules are the whole lock on the front door, so they are tested as rules
 * rather than as code. Four things must hold, and each has a real failure behind it:
 *
 *   • a stored digest reveals nothing — a six-digit code under an unkeyed hash is
 *     recoverable in milliseconds from a dump;
 *   • a digest is useless outside its own row — otherwise a code seen once can be
 *     replayed against somebody else's challenge;
 *   • guesses are counted and the *challenge* locks, never the account — or an
 *     attacker spraying codes at a stranger's number locks that stranger out;
 *   • a code works exactly once.
 */

/** Stands in for the platform data key. */
const hmac: Hmac = (value, label) =>
  createHmac('sha256', 'test-data-key').update(`${label}:${value}`).digest('base64url')

const DEST = 'destination-hash-abc'
const NOW = new Date('2026-08-27T10:00:00.000Z')

function challenge(overrides: Partial<OtpChallengeState> = {}): OtpChallengeState {
  return {
    id: 'otp-1',
    purpose: 'login',
    destinationHash: DEST,
    codeHash: hashOtpCode(hmac, { code: '448211', purpose: 'login', destinationHash: DEST }),
    attempts: 0,
    maxAttempts: 5,
    resendCount: 0,
    consumedAt: null,
    lockedAt: null,
    expiresAt: new Date(NOW.getTime() + 5 * 60_000),
    createdAt: NOW,
    ...overrides,
  }
}

describe('generateOtpCode', () => {
  it('is always six digits, leading zeros kept', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateOtpCode()
      expect(code, code).toMatch(/^\d{6}$/)
      expect(code.length, code).toBe(OTP_CODE_LENGTH)
    }
  })

  it('uses the whole space, including the codes a person would call suspicious', () => {
    // Excluding "000000" or "123456" would shrink the keyspace to make brute force
    // easier, not harder. The attempt cap is the defence.
    const seen = new Set<string>()
    for (let i = 0; i < 4000; i++) seen.add(generateOtpCode())
    expect(seen.size).toBeGreaterThan(3800)

    const firstDigits = new Set([...seen].map((code) => code[0]))
    expect(firstDigits.size).toBe(10)
  })
})

describe('normaliseOtpInput', () => {
  it('accepts the code the way it is actually pasted', () => {
    // Straight out of the SMS, with the spacing the SMS had.
    for (const input of ['448211', '448 211', ' 448211 ', '448-211', '4 4 8 2 1 1']) {
      expect(normaliseOtpInput(input), input).toBe('448211')
    }
  })

  it('accepts Indic digits', () => {
    expect(normaliseOtpInput('४४८२११')).toBe('448211')
  })

  it('strips the words when the whole message is pasted', () => {
    // Long-press-paste on Android grabs the entire notification.
    expect(normaliseOtpInput('Your Chaapo code is 448211')).toBe('448211')
  })

  it('leaves a wrong-length input wrong, rather than trimming it into shape', () => {
    expect(isWellFormedOtp(normaliseOtpInput('4482'))).toBe(false)
    expect(isWellFormedOtp(normaliseOtpInput('4482119'))).toBe(false)
    expect(isWellFormedOtp(normaliseOtpInput(''))).toBe(false)
    expect(isWellFormedOtp(normaliseOtpInput('448211'))).toBe(true)
  })
})

describe('hashOtpCode', () => {
  it('is deterministic for one code in one row', () => {
    const args = { code: '448211', purpose: 'login', destinationHash: DEST } as const
    expect(hashOtpCode(hmac, args)).toBe(hashOtpCode(hmac, args))
  })

  it('does not contain the code', () => {
    expect(hashOtpCode(hmac, { code: '448211', purpose: 'login', destinationHash: DEST })).not.toContain('448211')
  })

  it('is worthless without the key', () => {
    // The reason this is an HMAC and not a bare SHA-256. Anyone can compute
    // sha256("448211"); a dump of unkeyed digests is a dump of the codes.
    const otherKey: Hmac = (value, label) =>
      createHmac('sha256', 'not-the-data-key').update(`${label}:${value}`).digest('base64url')
    expect(hashOtpCode(otherKey, { code: '448211', purpose: 'login', destinationHash: DEST })).not.toBe(
      hashOtpCode(hmac, { code: '448211', purpose: 'login', destinationHash: DEST }),
    )
  })

  it('cannot be replayed across destinations or purposes', () => {
    // Without binding, one observed code matches every row that happens to share
    // it — including a challenge belonging to somebody else.
    const base = hashOtpCode(hmac, { code: '448211', purpose: 'login', destinationHash: DEST })
    expect(hashOtpCode(hmac, { code: '448211', purpose: 'login', destinationHash: 'other-dest' })).not.toBe(base)
    expect(hashOtpCode(hmac, { code: '448211', purpose: 'signup', destinationHash: DEST })).not.toBe(base)
  })
})

describe('evaluateOtp', () => {
  it('accepts the right code', () => {
    expect(evaluateOtp({ challenge: challenge(), code: '448211', now: NOW, hmac })).toEqual({
      kind: 'accepted',
    })
  })

  it('accepts the right code however it was pasted', () => {
    expect(evaluateOtp({ challenge: challenge(), code: ' 448 211 ', now: NOW, hmac }).kind).toBe('accepted')
    expect(evaluateOtp({ challenge: challenge(), code: '४४८२११', now: NOW, hmac }).kind).toBe('accepted')
  })

  it('rejects a wrong code and says how many guesses are left', () => {
    expect(evaluateOtp({ challenge: challenge(), code: '111111', now: NOW, hmac })).toEqual({
      kind: 'rejected',
      attemptsRemaining: 4,
    })
    expect(evaluateOtp({ challenge: challenge({ attempts: 3 }), code: '111111', now: NOW, hmac })).toEqual({
      kind: 'rejected',
      attemptsRemaining: 1,
    })
  })

  it('reports the last wrong guess separately, so the caller locks the challenge', () => {
    // `rejected` and `exhausted` differ only in that the second must also write
    // `locked_at`. Collapsing them is how a challenge quietly accepts unlimited
    // guesses.
    expect(evaluateOtp({ challenge: challenge({ attempts: 4 }), code: '111111', now: NOW, hmac })).toEqual({
      kind: 'exhausted',
    })
  })

  it('treats a challenge already at its cap as locked', () => {
    // A request that died between the increment and the lock leaves this row. It
    // must not be possible to push `attempts` past `otp_attempts_bounded`.
    expect(evaluateOtp({ challenge: challenge({ attempts: 5 }), code: '448211', now: NOW, hmac })).toEqual({
      kind: 'locked',
    })
  })

  it('refuses a locked challenge even with the right code', () => {
    expect(
      evaluateOtp({ challenge: challenge({ lockedAt: NOW }), code: '448211', now: NOW, hmac }),
    ).toEqual({ kind: 'locked' })
  })

  it('lets a code work exactly once', () => {
    expect(
      evaluateOtp({ challenge: challenge({ consumedAt: NOW }), code: '448211', now: NOW, hmac }),
    ).toEqual({ kind: 'consumed' })
  })

  it('expires the code on the second, not eventually', () => {
    const expiresAt = new Date(NOW.getTime() + 300_000)
    const state = challenge({ expiresAt })

    const justInside = new Date(expiresAt.getTime() - 1)
    const exactly = new Date(expiresAt.getTime())

    expect(evaluateOtp({ challenge: state, code: '448211', now: justInside, hmac }).kind).toBe('accepted')
    // The boundary is closed: at `expires_at` the code is gone, matching the
    // `expires_at DESC` lookup index which excludes it.
    expect(evaluateOtp({ challenge: state, code: '448211', now: exactly, hmac }).kind).toBe('expired')
  })

  it('says expired rather than incorrect when both are true', () => {
    // Telling someone they mistyped when their code simply aged out sends them
    // back to re-read an SMS that can no longer work.
    const stale = challenge({ expiresAt: new Date(NOW.getTime() - 1000) })
    expect(evaluateOtp({ challenge: stale, code: '111111', now: NOW, hmac }).kind).toBe('expired')
  })

  it('does not spend an attempt on something that is not a code', () => {
    // A stray keystroke or an autofill misfire should not cost one of five
    // guesses.
    for (const input of ['', '44', '4482119', 'abcdef']) {
      expect(evaluateOtp({ challenge: challenge(), code: input, now: NOW, hmac }), input).toEqual({
        kind: 'malformed',
      })
    }
  })

  it('will not accept a code minted for a different challenge', () => {
    const foreign = hashOtpCode(hmac, {
      code: '448211',
      purpose: 'login',
      destinationHash: 'somebody-elses-number',
    })
    expect(evaluateOtp({ challenge: challenge({ codeHash: foreign }), code: '448211', now: NOW, hmac }).kind).toBe(
      'rejected',
    )
  })
})

describe('resendDecision', () => {
  const pending = {
    resendCount: 0,
    consumedAt: null,
    lockedAt: null,
    expiresAt: new Date(NOW.getTime() + 300_000),
    createdAt: NOW,
  }

  it('allows a resend once the interval has passed', () => {
    expect(
      resendDecision({
        challenge: pending,
        lastSentAt: new Date(NOW.getTime() - 30_000),
        now: NOW,
        resendSeconds: 30,
      }),
    ).toEqual({ allowed: true })
  })

  it('holds the button and says for how long', () => {
    // The first SMS is usually still in flight; a second code arriving out of
    // order makes the first one look broken.
    expect(
      resendDecision({
        challenge: pending,
        lastSentAt: new Date(NOW.getTime() - 8_000),
        now: NOW,
        resendSeconds: 30,
      }),
    ).toEqual({ allowed: false, reason: 'too_soon', retryAfterSeconds: 22 })
  })

  it('rounds the wait up, so the client never retries a second early', () => {
    const decision = resendDecision({
      challenge: pending,
      lastSentAt: new Date(NOW.getTime() - 29_500),
      now: NOW,
      resendSeconds: 30,
    })
    expect(decision).toEqual({ allowed: false, reason: 'too_soon', retryAfterSeconds: 1 })
  })

  it('stops resending after a bounded number of sends', () => {
    // Every send costs money and lands on a real phone. An unbounded resend
    // button is an SMS-bombing tool pointed at whatever number is typed in.
    expect(
      resendDecision({
        challenge: { ...pending, resendCount: MAX_RESENDS },
        lastSentAt: new Date(NOW.getTime() - 600_000),
        now: NOW,
        resendSeconds: 30,
      }),
    ).toEqual({ allowed: false, reason: 'too_many' })
  })

  it('will not resend for a challenge that is finished', () => {
    for (const finished of [
      { ...pending, consumedAt: NOW },
      { ...pending, lockedAt: NOW },
      { ...pending, expiresAt: new Date(NOW.getTime() - 1) },
    ]) {
      expect(
        resendDecision({
          challenge: finished,
          lastSentAt: new Date(NOW.getTime() - 600_000),
          now: NOW,
          resendSeconds: 30,
        }),
      ).toEqual({ allowed: false, reason: 'not_pending' })
    }
  })
})

describe('otpExpiry', () => {
  it('is the configured TTL from now', () => {
    expect(otpExpiry(NOW, 300).toISOString()).toBe('2026-08-27T10:05:00.000Z')
  })
})
