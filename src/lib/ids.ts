import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

/**
 * Identifiers.
 *
 * Three distinct kinds, for three distinct jobs:
 *
 * 1. **UUID v7** — every primary key. Time-ordered, so index inserts stay at the
 *    right-hand edge of the B-tree instead of scattering like v4, which matters
 *    once `order_events` and `audit_logs` are large. Opaque to users.
 *
 * 2. **Human codes** — order numbers, pickup codes. Crockford base32
 *    (no I, L, O or U) so they survive being read aloud across a shop counter
 *    and typed by someone in a hurry. `normaliseHumanCode` folds the classic
 *    confusions (O→0, I/L→1) so a customer typing "OI" still matches "01".
 *
 * 3. **URL slugs** — QR payloads and share links. base64url, high entropy,
 *    server-resolved. The QR encodes *only* an opaque slug: scanning it hands
 *    over no order data and no signed token (PRD §35.3, FR-506).
 */

// ── UUID v7 ─────────────────────────────────────────────────────────────────

/**
 * RFC 9562 UUID v7: 48-bit big-endian Unix milliseconds, 4-bit version, 12 bits
 * of randomness, 2-bit variant, 62 bits of randomness.
 */
export function newId(now: number = Date.now()): string {
  const bytes = randomBytes(16)
  const ms = BigInt(Math.floor(now))

  bytes[0] = Number((ms >> 40n) & 0xffn)
  bytes[1] = Number((ms >> 32n) & 0xffn)
  bytes[2] = Number((ms >> 24n) & 0xffn)
  bytes[3] = Number((ms >> 16n) & 0xffn)
  bytes[4] = Number((ms >> 8n) & 0xffn)
  bytes[5] = Number(ms & 0xffn)

  // version 7
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  // variant 10
  bytes[8] = (bytes[8]! & 0x3f) | 0x80

  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/** Extract the embedded timestamp from a v7 id. Returns null for other versions. */
export function idTimestamp(id: string): Date | null {
  if (!isUuid(id)) return null
  const hex = id.replace(/-/g, '')
  if (hex[12] !== '7') return null
  return new Date(Number(BigInt(`0x${hex.slice(0, 12)}`)))
}

// ── Crockford base32 human codes ────────────────────────────────────────────

/** Crockford base32: 0-9 and A-Z minus I, L, O, U. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Draw `length` characters uniformly from the Crockford alphabet. */
export function randomCrockford(length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += CROCKFORD[randomInt(0, CROCKFORD.length)]!
  }
  return out
}

/**
 * Fold the readable-code confusions so a human transcription still matches.
 * Uppercases, strips separators and whitespace, maps O→0, I/L→1, U→V.
 */
export function normaliseHumanCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')
}

export const ORDER_NUMBER_PREFIX = 'CHP'
export const PICKUP_CODE_LENGTH = 6

/**
 * A customer-facing order number: `CHP-7K2M-9QD4`.
 * 8 Crockford characters ≈ 1.1 × 10^12 combinations; the DB unique index is the
 * real guarantee and the generator is retried on collision.
 */
export function newOrderNumber(): string {
  const body = randomCrockford(8)
  return `${ORDER_NUMBER_PREFIX}-${body.slice(0, 4)}-${body.slice(4)}`
}

export function isOrderNumber(value: string): boolean {
  return /^CHP-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(value.toUpperCase())
}

/**
 * A 6-character pickup code. Shown to the customer only after payment succeeds,
 * stored hashed + encrypted, and verified server-side before an order may reach
 * `collected` (PRD §F invariant 1, FR-503).
 */
export function newPickupCode(): string {
  return randomCrockford(PICKUP_CODE_LENGTH)
}

/** Group a pickup code for display: `7K2M9Q` → `7K2 M9Q`. */
export function formatPickupCode(code: string): string {
  const clean = code.toUpperCase()
  return clean.length === 6 ? `${clean.slice(0, 3)} ${clean.slice(3)}` : clean
}

// ── URL-safe slugs ──────────────────────────────────────────────────────────

/** base64url random token. 16 bytes → 22 chars, ~128 bits of entropy. */
export function randomSlug(bytes = 16): string {
  return randomBytes(bytes).toString('base64url')
}

/**
 * The opaque slug embedded in a pickup QR code, resolved server-side at
 * `/s/:slug`. Carries no order identifiers and no authority by itself.
 */
export function newQrSlug(): string {
  return randomSlug(16)
}

/** Idempotency keys we generate ourselves (webhook replays, worker jobs). */
export function newIdempotencyKey(prefix: string): string {
  return `${prefix}_${randomSlug(18)}`
}

/** Correlation id for request/worker tracing. */
export function newCorrelationId(): string {
  return randomSlug(9)
}

// ── Comparison ──────────────────────────────────────────────────────────────

/**
 * Constant-time string comparison for codes and tokens, so a verification
 * endpoint cannot be used as an oracle.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the timing does not reveal the length.
    timingSafeEqual(bufA, bufA)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

/**
 * A URL-safe, lower-case slug for shop handles: "Sharma Xerox & Stationery,
 * Kothrud" → "sharma-xerox-stationery-kothrud".
 */
export function slugify(input: string, maxLength = 60): string {
  const base = input
    .normalize('NFKD')
    // Strip combining diacritical marks (U+0300–U+036F) left behind by NFKD.
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base.slice(0, maxLength).replace(/-+$/, '')
}
