import { randomInt } from 'node:crypto'

import { onlyDigits } from '../../lib/digits'
import { verifySignature } from '../core/crypto'

/**
 * One-time codes.
 *
 * This module is the decision layer only: it generates codes, hashes them, and —
 * given a challenge row and a typed code — says what should happen. It touches no
 * database and no clock of its own, because the rules it encodes are the ones most
 * worth testing and least worth discovering in production:
 *
 *   • a code expires (5 minutes, `security.otp_ttl_seconds`);
 *   • a code can be used once;
 *   • a fixed number of wrong guesses locks the challenge rather than the account,
 *     so an attacker spraying codes at a stranger's number cannot lock that
 *     stranger out of their own account (§45);
 *   • resends are spaced, and bounded.
 *
 * **Hashing deviates from the plan, deliberately.** §4.1 said SHA-256 of the code.
 * A six-digit code is about twenty bits: a plain unkeyed digest of it is not a
 * one-way function in any useful sense — a laptop enumerates the whole space
 * instantly, so `otp_challenges.code_hash` in a database dump would be equivalent
 * to storing the codes in the clear. Worse, an unbound digest is identical across
 * rows, so a code observed for one destination can be replayed against another
 * person's challenge. What is stored instead is a keyed HMAC bound to the purpose
 * and the destination, which fixes both: without the data key there is nothing to
 * enumerate, and the digest is meaningless anywhere but its own row.
 */

/** Six digits: what fits in an SMS, in muscle memory, and in an autofill hint. */
export const OTP_CODE_LENGTH = 6

/** Mirrors the `purpose` union on `otp_challenges`. */
export type OtpPurpose =
  | 'login'
  | 'signup'
  | 'phone_change'
  | 'email_verify'
  | 'password_reset'
  | 'staff_invite'
  | 'high_value_confirm'

/** The keyed HMAC this module is given, so it never has to hold the data key. */
export type Hmac = (value: string, label: string) => string

/**
 * A uniformly random six-digit code, leading zeros included.
 *
 * Deliberately not filtered: `000000` and `123456` are as likely as anything else.
 * Excluding "guessable" codes would shrink the space to make a brute force
 * *easier*, and with five attempts against a million values the real defence is the
 * attempt cap, not the aesthetics of the code.
 */
export function generateOtpCode(): string {
  return String(randomInt(0, 10 ** OTP_CODE_LENGTH)).padStart(OTP_CODE_LENGTH, '0')
}

/**
 * Reduce whatever the user typed or pasted to bare digits.
 *
 * People paste `448 211` out of the SMS, or the whole message; autofill sometimes
 * includes a trailing space; a Hindi keyboard produces ४४८२११. All of those are the
 * right code, and rejecting them as "incorrect" is indistinguishable from being
 * wrong about the code itself.
 */
export function normaliseOtpInput(input: string): string {
  return onlyDigits(input)
}

/** True when the input could be a code at all. Costs no attempt to find out. */
export function isWellFormedOtp(code: string): boolean {
  return code.length === OTP_CODE_LENGTH
}

/**
 * The value stored in `otp_challenges.code_hash`.
 *
 * Bound to the purpose and the destination, so the digest for "login code 448211
 * for +9198…" is unrelated to the digest for "signup code 448211 for +9199…".
 */
export function hashOtpCode(
  hmac: Hmac,
  params: { code: string; purpose: OtpPurpose; destinationHash: string },
): string {
  return hmac(params.code, `otp:${params.purpose}:${params.destinationHash}`)
}

/** The subset of an `otp_challenges` row these rules need. */
export interface OtpChallengeState {
  id: string
  purpose: OtpPurpose
  destinationHash: string
  codeHash: string
  attempts: number
  maxAttempts: number
  resendCount: number
  consumedAt: Date | null
  lockedAt: Date | null
  expiresAt: Date
  createdAt: Date
}

/**
 * What the caller should do about a submitted code.
 *
 * `rejected` and `exhausted` both mean the code was wrong; they are separate
 * because the second one must also write `locked_at`, and conflating them is how a
 * challenge ends up accepting an unlimited number of guesses.
 */
export type OtpVerdict =
  | { kind: 'accepted' }
  | { kind: 'malformed' }
  | { kind: 'expired' }
  | { kind: 'consumed' }
  | { kind: 'locked' }
  | { kind: 'rejected'; attemptsRemaining: number }
  | { kind: 'exhausted' }

/**
 * Decide a submitted code. Pure: the caller owns the clock, the row and the write.
 *
 * Order matters. The terminal states of the challenge are checked before the code
 * itself, so a person whose code has expired is told that rather than that they
 * mistyped — and so a wrong guess against an already-locked challenge cannot push
 * the attempt counter past its CHECK constraint.
 */
export function evaluateOtp(params: {
  challenge: OtpChallengeState
  code: string
  now: Date
  hmac: Hmac
}): OtpVerdict {
  const { challenge, now, hmac } = params

  if (challenge.consumedAt !== null) return { kind: 'consumed' }
  if (challenge.lockedAt !== null) return { kind: 'locked' }
  // Defensive: a row at its cap without `locked_at` set means a previous request
  // died between the increment and the lock. Treat it as locked either way.
  if (challenge.attempts >= challenge.maxAttempts) return { kind: 'locked' }
  if (challenge.expiresAt.getTime() <= now.getTime()) return { kind: 'expired' }

  const code = normaliseOtpInput(params.code)
  // Costs no attempt: there is nothing to learn from a malformed guess, and
  // burning an attempt on a stray keystroke is a support ticket.
  if (!isWellFormedOtp(code)) return { kind: 'malformed' }

  const expected = hashOtpCode(hmac, {
    code,
    purpose: challenge.purpose,
    destinationHash: challenge.destinationHash,
  })
  if (verifySignature(challenge.codeHash, expected)) return { kind: 'accepted' }

  const attemptsRemaining = challenge.maxAttempts - (challenge.attempts + 1)
  return attemptsRemaining <= 0 ? { kind: 'exhausted' } : { kind: 'rejected', attemptsRemaining }
}

/** How many resends one challenge may have before a new one must be requested. */
export const MAX_RESENDS = 3

export type ResendDecision =
  | { allowed: true }
  | { allowed: false; reason: 'too_soon'; retryAfterSeconds: number }
  | { allowed: false; reason: 'too_many' }
  | { allowed: false; reason: 'not_pending' }

/**
 * Whether "Resend code" may send another SMS for this challenge.
 *
 * Two separate limits, for two separate reasons. The interval
 * (`security.otp_resend_seconds`, 30 s) exists because the first SMS is usually
 * still in flight and a second one arriving out of order makes the first code look
 * broken. The count exists because each send costs money and lands on a real
 * phone — an unbounded resend button is an SMS-bombing tool aimed at whichever
 * number is typed into it.
 */
export function resendDecision(params: {
  challenge: Pick<OtpChallengeState, 'resendCount' | 'consumedAt' | 'lockedAt' | 'expiresAt' | 'createdAt'>
  lastSentAt: Date
  now: Date
  resendSeconds: number
  maxResends?: number
}): ResendDecision {
  const { challenge, now, lastSentAt, resendSeconds } = params
  const maxResends = params.maxResends ?? MAX_RESENDS

  if (challenge.consumedAt !== null || challenge.lockedAt !== null) {
    return { allowed: false, reason: 'not_pending' }
  }
  if (challenge.expiresAt.getTime() <= now.getTime()) return { allowed: false, reason: 'not_pending' }
  if (challenge.resendCount >= maxResends) return { allowed: false, reason: 'too_many' }

  const elapsedMs = now.getTime() - lastSentAt.getTime()
  const waitMs = resendSeconds * 1000 - elapsedMs
  if (waitMs > 0) {
    return { allowed: false, reason: 'too_soon', retryAfterSeconds: Math.ceil(waitMs / 1000) }
  }
  return { allowed: true }
}

/** When a code requested now should stop working. */
export function otpExpiry(now: Date, ttlSeconds: number): Date {
  return new Date(now.getTime() + ttlSeconds * 1000)
}
