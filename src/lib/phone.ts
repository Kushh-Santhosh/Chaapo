/**
 * Indian phone numbers.
 *
 * The phone number is the primary credential: a customer's account *is* their
 * number, and `users.phone_hash` — a keyed HMAC of the normalised value — is the
 * unique index that decides whether a sign-in finds an existing account or
 * silently creates a second one. So normalisation is not formatting politeness,
 * it is an identity invariant: `98765 43210`, `+91 98765-43210`, `09876543210`
 * and `919876543210` are one person and must produce one hash.
 *
 * This module is isomorphic on purpose. The customer PWA validates the number as
 * it is typed, and the server normalises again before hashing — the client's
 * answer is never trusted, but showing "That doesn't look like a mobile number"
 * before the OTP is spent is worth the shared code.
 *
 * Scope is deliberately India-only (PRD §1: India-first, DLT-registered SMS and
 * an Indian payment aggregator). A number that is not reachable on +91 cannot be
 * sent an OTP, so accepting one would only fail later and less clearly.
 */

import { toAsciiDigits } from './digits'

/** The only country we can deliver an OTP to. */
export const COUNTRY_CODE = '91'
export const COUNTRY_PREFIX = `+${COUNTRY_CODE}`

/** Every Indian number is ten digits once the country and trunk prefixes are off. */
export const NSN_LENGTH = 10

/**
 * Indian mobile numbers begin 6, 7, 8 or 9; most landline area codes begin 1–5.
 *
 * This is a heuristic and it is deliberately biased. Two metro area codes — 079
 * (Ahmedabad) and 080 (Bangalore) — begin 7 and 8, and the 79xxx and 80xxx mobile
 * series are both really allocated, so no prefix rule can separate them. Given
 * the choice, we let a Bangalore landline through as "mobile" rather than reject
 * a genuine mobile: the first costs one undelivered OTP and a "didn't get it?"
 * retry, the second locks a real customer out of the product with a message
 * telling them their own number is wrong.
 */
const MOBILE_FIRST_DIGITS = new Set(['6', '7', '8', '9'])

export type PhoneKind = 'mobile' | 'landline'

/** Strip separators and fold Indic digits, leaving `+` and any stray characters. */
function compact(input: string): string {
  return toAsciiDigits(input).replace(/[\s\-().]/g, '')
}

/**
 * Strip a number to its national significant digits, or return null if it cannot
 * be one.
 *
 * Accepts what people actually type and paste: spaces, dashes, brackets, dots, a
 * leading `0`, a leading `91`, `+91`, and the `00`-style international prefix.
 * Rejects anything with a different country code rather than guessing.
 */
function toNsn(input: string): string | null {
  if (typeof input !== 'string') return null

  const digits = compact(input)
  if (digits === '') return null

  let rest = digits
  if (rest.startsWith('+')) rest = rest.slice(1)
  else if (rest.startsWith('00')) rest = rest.slice(2)

  if (!/^\d+$/.test(rest)) return null

  // `91` is only a country code when what follows is a full national number.
  // Without that check, the Mumbai landline 22 91 XX XX XX would lose its middle.
  if (rest.length === NSN_LENGTH + COUNTRY_CODE.length && rest.startsWith(COUNTRY_CODE)) {
    rest = rest.slice(COUNTRY_CODE.length)
  } else if (rest.length === NSN_LENGTH + 1 && rest.startsWith('0')) {
    // Domestic trunk prefix: 09876543210.
    rest = rest.slice(1)
  } else if (rest.length === NSN_LENGTH + COUNTRY_CODE.length + 1 && rest.startsWith(`${COUNTRY_CODE}0`)) {
    // Both, which is wrong but common: +91 098765 43210.
    rest = rest.slice(COUNTRY_CODE.length + 1)
  }

  if (rest.length !== NSN_LENGTH) return null
  // No Indian number starts with 0 or 9-followed-by-nothing; 0 is the trunk code
  // and has already been handled, so a leading 0 here is a typo.
  if (rest.startsWith('0')) return null
  return rest
}

/**
 * The canonical form stored (encrypted) and hashed: `+919876543210`.
 *
 * Returns null rather than throwing, because every caller has a better error to
 * give than an exception: a field error on a form, or a validation failure on the
 * API.
 */
export function normalisePhone(input: string): string | null {
  const nsn = toNsn(input)
  return nsn === null ? null : `${COUNTRY_PREFIX}${nsn}`
}

/**
 * Mobile or landline, for a number that has already been normalised.
 *
 * A heuristic on the leading digit — see `MOBILE_FIRST_DIGITS` for why it cannot
 * be exact, and why it errs towards "mobile".
 */
export function phoneKind(e164: string): PhoneKind | null {
  const nsn = toNsn(e164)
  if (nsn === null) return null
  return MOBILE_FIRST_DIGITS.has(nsn[0] as string) ? 'mobile' : 'landline'
}

/**
 * Normalise, and require a number an OTP can reach.
 *
 * Used for anything that is a credential or a notification destination. A shop's
 * published contact number may be a landline (`normalisePhone`); the number a
 * person signs in with may not.
 */
export function normaliseMobile(input: string): string | null {
  const e164 = normalisePhone(input)
  if (e164 === null) return null
  return phoneKind(e164) === 'mobile' ? e164 : null
}

export function isMobile(input: string): boolean {
  return normaliseMobile(input) !== null
}

/** `+919876543210` → `+91 98765 43210`. For display and for read-back in an SMS. */
export function formatPhone(input: string): string {
  const nsn = toNsn(input)
  if (nsn === null) return input
  return `${COUNTRY_PREFIX} ${nsn.slice(0, 5)} ${nsn.slice(5)}`
}

/**
 * The last four digits, for "we sent a code to a number ending 3210".
 *
 * Enough for a person to recognise their own number and not enough for anyone
 * else to learn it — which is why this, and not the number, goes in the OTP
 * screen's copy and in support tooling.
 */
export function phoneLast4(input: string): string | null {
  const nsn = toNsn(input)
  return nsn === null ? null : nsn.slice(-4)
}

/**
 * A one-line, human-readable reason a number was rejected.
 *
 * The messages are product copy, not error codes: they are shown under the input
 * on the sign-in screen, which is the single highest-friction moment in the whole
 * funnel (§21).
 */
export function describePhoneProblem(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed === '') return 'Enter your mobile number.'

  const compacted = compact(trimmed)
  const withoutPlus = compacted.replace(/^\+/, '')

  // Letters or symbols mean this is not a mangled number, it is not a number.
  // Telling someone their number is "too short" when they typed a word is the
  // kind of message that makes people distrust the whole form.
  if (/\D/.test(withoutPlus)) return 'That does not look like an Indian mobile number.'

  const e164 = normalisePhone(trimmed)

  if (e164 === null) {
    if (/^(\+|00)/.test(compacted) && !/^(\+|00)?91/.test(compacted)) {
      return 'Chaapo works with Indian mobile numbers only, for now.'
    }
    if (withoutPlus.length < NSN_LENGTH) return 'That number is too short. Enter all 10 digits.'
    if (withoutPlus.length > NSN_LENGTH + COUNTRY_CODE.length + 1) {
      return 'That number has too many digits.'
    }
    return 'That does not look like an Indian mobile number.'
  }

  if (phoneKind(e164) === 'landline') {
    return 'That looks like a landline. Enter a mobile number so we can send you a code.'
  }
  return null
}
