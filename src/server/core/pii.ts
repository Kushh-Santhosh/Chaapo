import { getConfig } from '../config/index'
import {
  createEncryptor,
  maskEmail,
  maskPhone,
  type CryptoPurpose,
  type Encryptor,
} from './crypto'

/**
 * How personal data becomes columns.
 *
 * Every piece of PII in this system is stored three times over, and the split is
 * what makes the privacy commitments in PRD §57 actually enforceable:
 *
 *   • `*_encrypted` — AES-256-GCM, purpose-bound. The only reversible copy. Read
 *     when we genuinely need the value: sending an SMS, printing an invoice.
 *   • `*_hash`      — a keyed HMAC blind index. Carries the unique index and
 *     answers "is this person already a user?" without a plaintext column to
 *     leak, and without a `LIKE` scan over ciphertext.
 *   • `*_masked`    — `+91 98••• •3210`. What the shop dashboard, the admin
 *     console and every support screen render by default. Nobody browsing the
 *     product ever sees a full phone number.
 *
 * Centralising the triple here is the point. If each domain built it by hand,
 * one of them would eventually hash an un-normalised phone number — and a blind
 * index computed over `98765 43210` does not match one computed over
 * `+919876543210`, which means a duplicate account and a fork in someone's order
 * history. There is no error message for that; it just silently happens.
 *
 * Aadhaar appears nowhere in this module. It is never persisted in any form
 * (§57.2) — the KYC flow keeps a masked last-four for display and a provider
 * verification reference, and nothing else.
 */

let cached: Encryptor | null = null

/** The process-wide encryptor, keyed from the platform secret store. */
export function getEncryptor(): Encryptor {
  if (!cached) cached = createEncryptor(getConfig().secrets.encryptionKey)
  return cached
}

/** Test-only. Pass null to fall back to the configured key. */
export function __setEncryptorForTests(encryptor: Encryptor | null): void {
  cached = encryptor
}

/** The three columns a PII field expands into. */
export interface ProtectedValue {
  encrypted: string
  hash: string
  masked: string
}

/**
 * Protect an already-normalised phone number.
 *
 * The caller must have run it through `normalisePhone`/`normaliseMobile` first —
 * this function will not silently accept a raw input, because a blind index over
 * an un-normalised value is worse than useless: it looks like it works right up
 * to the moment it creates a second account for the same person.
 */
export function protectPhone(
  e164: string,
  purpose: Extract<CryptoPurpose, 'user.phone' | 'shop.contact_phone' | 'shop.owner_phone'> = 'user.phone',
): ProtectedValue {
  assertNormalisedPhone(e164)
  const encryptor = getEncryptor()
  return {
    encrypted: encryptor.encrypt(e164, purpose),
    // Deliberately *not* purpose-bound: a person signing in as a customer and
    // being listed as a shop's owner is one identity, and the lookup has to find
    // them from either side.
    hash: hashPhone(e164),
    masked: maskPhone(e164),
  }
}

/** The blind index alone, for a lookup that does not need to write. */
export function hashPhone(e164: string): string {
  assertNormalisedPhone(e164)
  return getEncryptor().blindIndex(e164, 'user.phone')
}

export function revealPhone(
  encrypted: string,
  purpose: Extract<CryptoPurpose, 'user.phone' | 'shop.contact_phone' | 'shop.owner_phone'> = 'user.phone',
): string {
  return getEncryptor().decrypt(encrypted, purpose)
}

/**
 * Normalise an email address, or return null.
 *
 * Only case and surrounding whitespace are normalised. Stripping dots or
 * `+tags` — the trick for collapsing Gmail aliases — is deliberately *not* done:
 * those are different addresses at most providers, and treating them as one would
 * let someone claim an account belonging to a real person at a real address.
 */
export function normaliseEmail(input: string): string | null {
  const trimmed = input.trim().toLowerCase()
  if (trimmed === '') return null
  // Not RFC 5322 — a deliberately boring check. Real validation is "we sent a
  // link to it and you clicked".
  if (!/^[^\s@,;<>"]+@[^\s@.,;<>"]+(\.[^\s@.,;<>"]+)+$/.test(trimmed)) return null
  if (trimmed.length > 254) return null
  return trimmed
}

export function protectEmail(normalised: string): ProtectedValue {
  const encryptor = getEncryptor()
  return {
    encrypted: encryptor.encrypt(normalised, 'user.email'),
    hash: hashEmail(normalised),
    masked: maskEmail(normalised),
  }
}

export function hashEmail(normalised: string): string {
  return getEncryptor().blindIndex(normalised, 'user.email')
}

export function revealEmail(encrypted: string): string {
  return getEncryptor().decrypt(encrypted, 'user.email')
}

/**
 * Reduce an IP address to a non-reversible tag.
 *
 * `sessions.ip_hash`, `users.last_ip_hash` and `login_attempts.ip_hash` exist to
 * answer two questions — "is this the same origin as last time?" and "how many
 * accounts is this origin attacking?" — and neither needs the address itself.
 * Storing the hash means a database dump cannot be turned into a map of where a
 * customer lives.
 *
 * IPv4 is used whole. IPv6 is truncated to its /64 first, because the low half is
 * frequently a rotating privacy address and hashing it would make every request
 * from one device look like a different origin.
 */
export function hashIp(ip: string): string {
  return getEncryptor().hmac(canonicaliseIp(ip), 'ip')
}

function canonicaliseIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase()
  // `::ffff:203.0.113.4` — an IPv4 address arriving over an IPv6 socket.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(trimmed)
  if (mapped) return mapped[1] as string
  if (!trimmed.includes(':')) return trimmed

  // Expand, keep the first four groups (/64), drop the interface identifier.
  const groups = expandIpv6(trimmed)
  return groups === null ? trimmed : `${groups.slice(0, 4).join(':')}::/64`
}

function expandIpv6(ip: string): string[] | null {
  const halves = ip.split('::')
  if (halves.length > 2) return null
  const head = halves[0] === '' ? [] : (halves[0] as string).split(':')
  const tail = halves.length === 2 && halves[1] !== '' ? (halves[1] as string).split(':') : []
  if (head.length + tail.length > 8) return null
  const middle = Array.from({ length: 8 - head.length - tail.length }, () => '0')
  const groups = halves.length === 2 ? [...head, ...middle, ...tail] : head
  if (groups.length !== 8) return null
  return groups.map((group) => (group === '' ? '0' : group.padStart(4, '0')))
}

/**
 * Hash an arbitrary identifier for a rate-limit or attempt-log key.
 *
 * `login_attempts.identifier_hash` and `otp_challenges.destination_hash` both use
 * this. The identifier may be a phone number, an email, or a user id, and the
 * point is that a dump of the attempt log — which by design records *failed*
 * sign-ins, i.e. numbers that may not even belong to our users — reveals nothing.
 */
export function hashIdentifier(value: string): string {
  return getEncryptor().hmac(value.trim().toLowerCase(), 'identifier')
}

/**
 * Reduce a User-Agent string to a coarse family.
 *
 * `sessions` and `login_attempts` keep this so a customer can recognise their own
 * devices in "you're signed in on…" (§45) and so support can tell a bot from a
 * browser. The full string is a fingerprint; the family is not, and the family is
 * all either use needs.
 */
export function userAgentFamily(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null
  const ua = userAgent.toLowerCase()

  const platform =
    /iphone|ipad|ipod/.test(ua) ? 'iOS'
    : /android/.test(ua) ? 'Android'
    : /windows/.test(ua) ? 'Windows'
    : /mac os x|macintosh/.test(ua) ? 'macOS'
    : /linux|x11/.test(ua) ? 'Linux'
    : null

  // Order matters: every one of these also claims to be Safari or Chrome.
  const browser =
    /edg\//.test(ua) ? 'Edge'
    : /opr\/|opera/.test(ua) ? 'Opera'
    : /samsungbrowser/.test(ua) ? 'Samsung Internet'
    : /firefox|fxios/.test(ua) ? 'Firefox'
    : /crios|chrome|chromium/.test(ua) ? 'Chrome'
    : /safari/.test(ua) ? 'Safari'
    : /curl|wget|python|node|go-http|okhttp|axios|postman/.test(ua) ? 'Script'
    : /bot|crawler|spider/.test(ua) ? 'Bot'
    : null

  if (browser && platform) return `${browser} on ${platform}`
  return browser ?? platform ?? 'Unknown'
}

function assertNormalisedPhone(value: string): void {
  // A programmer error, not a user error: normalisation belongs to whichever
  // layer parsed the input, and failing loudly here is how it stays there.
  if (!/^\+91\d{10}$/.test(value)) {
    throw new Error('Phone number must be normalised to E.164 (+91XXXXXXXXXX) before it is protected')
  }
}
