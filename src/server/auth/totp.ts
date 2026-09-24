import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { onlyDigits } from '../../lib/digits'

/**
 * Time-based one-time passwords (RFC 6238), for admin and shop-owner second
 * factors.
 *
 * Written against the RFC rather than taken from a library, for two reasons. The
 * first is that it can then be checked against the RFC's own published vectors,
 * which is the only test of a TOTP implementation that means anything — a wrong
 * one still produces six plausible digits, and the bug surfaces as "my
 * authenticator app doesn't work" from an admin who is locked out. The second is
 * that the two rules that actually make TOTP safe are not in the algorithm at all,
 * and both need to be explicit here:
 *
 *   • **A window, not a moment.** Phone clocks drift, and a person takes a few
 *     seconds to type. We accept the current step and one on either side (±30 s).
 *     Wider than that starts handing an attacker free minutes.
 *
 *   • **A code is single-use.** Inside a 30-second step the same six digits stay
 *     valid, so a code shoulder-surfed or replayed from a proxied form works twice
 *     unless the accepted step is remembered. `user_totp.last_used_counter` is
 *     that memory, and `verifyTotp` refuses anything at or below it.
 *
 * The shared secret is stored encrypted (`user_totp.secret_encrypted`); this module
 * only ever sees the decrypted base32.
 */

/** RFC 6238 defaults, and what every authenticator app assumes. */
export const TOTP_DIGITS = 6
export const TOTP_STEP_SECONDS = 30
export const TOTP_ALGORITHM = 'SHA1' as const

/**
 * How many steps either side of now are accepted.
 *
 * One. That is ±30 seconds, which covers a drifting phone clock and a person
 * reading digits off a screen. Each extra step is another 30 seconds in which a
 * captured code stays live, so this is a security parameter, not a comfort one.
 */
export const TOTP_WINDOW_STEPS = 1

// ── base32 (RFC 4648, no padding) ───────────────────────────────────────────
// Authenticator apps take base32, so the secret is carried in that form.

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buffer: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/** Returns null for anything that is not valid base32, rather than guessing. */
export function base32Decode(input: string): Buffer | null {
  // Users paste secrets in groups of four, sometimes lower-case, sometimes with
  // the `=` padding an exporter added.
  const clean = input.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '')
  if (clean === '') return null

  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index === -1) return null
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/**
 * A new shared secret.
 *
 * 20 bytes — the RFC 4226 recommendation, and what every authenticator app
 * expects. 32 base32 characters, which is short enough to type by hand when the QR
 * code will not scan.
 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

/** The RFC 6238 time step for an instant. */
export function totpCounter(at: Date, stepSeconds = TOTP_STEP_SECONDS): number {
  return Math.floor(at.getTime() / 1000 / stepSeconds)
}

/**
 * The HOTP value for a counter (RFC 4226 §5.3), zero-padded.
 *
 * Exported because the RFC's test vectors are stated in terms of the counter, and a
 * TOTP implementation that is not checked against them is not checked at all.
 */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8)
  // A 64-bit counter written big-endian. `writeBigUInt64BE` rather than two 32-bit
  // halves so the high word is correct past 2^32 steps — which the RFC's own
  // vectors reach, and which real time reaches in the year 6053.
  message.writeBigUInt64BE(BigInt(counter))

  const digest = createHmac('sha1', secret).update(message).digest()
  // Dynamic truncation: the low nibble of the last byte selects the offset.
  const offset = (digest[digest.length - 1] as number) & 0x0f
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff)

  return String(binary % 10 ** digits).padStart(digits, '0')
}

/** The code an authenticator app is showing right now. */
export function totpCode(secretBase32: string, at: Date, digits = TOTP_DIGITS): string | null {
  const secret = base32Decode(secretBase32)
  if (secret === null) return null
  return hotp(secret, totpCounter(at), digits)
}

export type TotpVerdict =
  | { ok: true; counter: number }
  | { ok: false; reason: 'malformed' | 'bad_secret' | 'incorrect' | 'replayed' }

/**
 * Verify a submitted code.
 *
 * On success the accepted counter comes back, and the caller **must** persist it to
 * `user_totp.last_used_counter`. That write is what makes a code single-use; without
 * it the same six digits stay valid for the rest of their 30-second step and a
 * replayed code is indistinguishable from a fresh one.
 */
export function verifyTotp(params: {
  secretBase32: string
  code: string
  at: Date
  /** `user_totp.last_used_counter`. Null for a secret that has never been used. */
  lastUsedCounter?: number | bigint | null
  windowSteps?: number
  digits?: number
}): TotpVerdict {
  const digits = params.digits ?? TOTP_DIGITS
  const window = params.windowSteps ?? TOTP_WINDOW_STEPS

  const code = onlyDigits(params.code)
  if (code.length !== digits) return { ok: false, reason: 'malformed' }

  const secret = base32Decode(params.secretBase32)
  if (secret === null || secret.byteLength === 0) return { ok: false, reason: 'bad_secret' }

  const current = totpCounter(params.at)
  const lastUsed = params.lastUsedCounter === null || params.lastUsedCounter === undefined
    ? null
    : Number(params.lastUsedCounter)

  // Oldest first, so the counter we report is the earliest step that matches. That
  // keeps `last_used_counter` monotonic without ever skipping a step forward.
  for (let offset = -window; offset <= window; offset++) {
    const counter = current + offset
    if (counter < 0) continue
    if (!constantTimeEqual(hotp(secret, counter, digits), code)) continue
    // Correct digits, but for a step already spent. Distinguished from `incorrect`
    // so the caller can log a replay attempt rather than a typo — the two mean very
    // different things about what is happening to an account.
    if (lastUsed !== null && counter <= lastUsed) return { ok: false, reason: 'replayed' }
    return { ok: true, counter }
  }
  return { ok: false, reason: 'incorrect' }
}

/**
 * The `otpauth://` URI a QR code encodes.
 *
 * `issuer` is repeated in the label and the parameter on purpose: older apps read
 * one, newer apps read the other, and getting it wrong shows the entry as a bare
 * email address among a dozen others.
 */
export function totpProvisioningUri(params: {
  secretBase32: string
  account: string
  issuer?: string
}): string {
  const issuer = params.issuer ?? 'Chaapo'
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(params.account)}`
  const query = new URLSearchParams({
    secret: params.secretBase32,
    issuer,
    algorithm: TOTP_ALGORITHM,
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${query.toString()}`
}

/**
 * Group a secret for reading aloud or typing by hand: `JBSW Y3DP EHPK 3PXP`.
 *
 * The QR code fails often enough — a cracked screen, a shop's shared tablet, a
 * desktop with no camera — that the manual path has to be usable.
 */
export function formatTotpSecret(secretBase32: string): string {
  return (secretBase32.match(/.{1,4}/g) ?? []).join(' ')
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.byteLength !== right.byteLength) {
    timingSafeEqual(left, left)
    return false
  }
  return timingSafeEqual(left, right)
}
