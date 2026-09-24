import { randomBytes } from 'node:crypto'

import { isUuid, newId } from '../../lib/ids'
import { hmacSha256Base64Url, verifySignature } from '../core/crypto'

/**
 * The two kinds of token this product hands out, and why they are different shapes.
 *
 * **Composite tokens** (`<id>.<secret>`) are for anything with a database row behind
 * it: session tokens, refresh tokens, staff invitations. The row's id travels in the
 * clear alongside a 256-bit secret, and only a digest of the secret is stored.
 *
 * The obvious alternative — a bare opaque token looked up by its hash — is one index
 * lookup and looks simpler. It cannot express the rule that matters most, though.
 * Refresh rotation says: if a refresh token is presented *after* it has been rotated,
 * assume it was stolen and revoke the whole family (§45). A hash lookup of a rotated
 * token finds nothing, so there is no family to revoke and the theft is indistinguishable
 * from a typo. Carrying the id makes it a primary-key lookup: the row is found, the
 * secret does not match the current generation, and the family can be killed. The same
 * property makes the hash column re-keyable and lets a rejected token be logged as
 * *which* session it claimed to be.
 *
 * **Signed tokens** (`<payload>.<signature>`) are for things that must work with no
 * row at all. The `mfa_token` between a password and a TOTP code is the reason: it
 * exists precisely because no session may be issued until the second factor is
 * satisfied, and giving it a table would mean storing half-authenticated logins. A
 * five-minute HMAC-signed token cannot be extended, cannot be re-purposed, and
 * disappears on its own.
 *
 * Neither kind is a JWT. There is no algorithm field to confuse, no `none`, and no
 * library that will accept a header telling it what to do.
 */

// ── Composite tokens ────────────────────────────────────────────────────────

/** `.` is outside the base64url alphabet and outside UUID's, so it cannot collide. */
const COMPOSITE_SEPARATOR = '.'

/** 256 bits. The secret half is what the whole scheme rests on. */
const SECRET_BYTES = 32

export interface CompositeToken {
  /** The row id, sent to the client and safe to log. */
  id: string
  /** The secret half. Never stored, never logged. */
  secret: string
  /** What the client receives: `<id>.<secret>`. */
  token: string
  /** What the database stores. */
  hash: string
}

/**
 * Mint a token for a row that already has an id (or is about to be created with the
 * one returned here).
 */
export function mintCompositeToken(id: string = newId()): CompositeToken {
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  return {
    id,
    secret,
    token: `${id}${COMPOSITE_SEPARATOR}${secret}`,
    hash: hashTokenSecret(secret),
  }
}

/**
 * Split a presented token, or return null.
 *
 * Strict about shape on purpose: this runs on every authenticated request with a
 * string an attacker controls, and the id is about to be used as a database key.
 */
export function parseCompositeToken(token: string): { id: string; secret: string } | null {
  if (typeof token !== 'string') return null

  const separator = token.indexOf(COMPOSITE_SEPARATOR)
  if (separator <= 0) return null

  const id = token.slice(0, separator)
  const secret = token.slice(separator + 1)

  // The secret must not itself contain a separator: exactly two parts, or nothing.
  if (secret.includes(COMPOSITE_SEPARATOR)) return null
  if (!isUuid(id)) return null
  // 32 bytes base64url is 43 characters. A short secret means a truncated or
  // hand-made token, and there is no reason to spend a hash on it.
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return null

  return { id, secret }
}

/**
 * The value stored in `sessions.token_hash` / `sessions.refresh_token_hash`.
 *
 * Only the secret is hashed. The id is already the row's primary key, so including
 * it would add nothing and would tie the digest to a value that appears in logs.
 *
 * A plain keyed digest with no salt and no stretching, deliberately: the input is 256
 * bits of randomness, so there is no dictionary to attack and no reason to pay scrypt
 * on every request. (This is the opposite of a password, where the input is guessable
 * and stretching is the entire defence.)
 */
export function hashTokenSecret(secret: string): string {
  return hmacSha256Base64Url('chaapo.session.v1', secret)
}

/** Constant-time check of a presented secret against the stored digest. */
export function tokenSecretMatches(storedHash: string, secret: string): boolean {
  return verifySignature(storedHash, hashTokenSecret(secret))
}

// ── Signed tokens ───────────────────────────────────────────────────────────

/**
 * Every signed token says what it is for, and verification requires the caller to
 * name the purpose it expects. Without that, a token minted for one job is a valid
 * token for every other job with the same subject — a CSRF token becoming an MFA
 * bypass is the exact shape of that bug.
 */
export type SignedTokenPurpose =
  | 'mfa'
  | 'csrf'
  | 'email_verify'
  | 'password_reset'
  | 'privacy_export'
  | 'unsubscribe'
  /**
   * Identifies the owner of an unsigned-in upload draft. Carries no authority beyond
   * "these files are the ones this browser uploaded", and is replaced by the real user id
   * when the draft becomes an order.
   */
  | 'draft_owner'

/** Wire payload. Keys are short because a CSRF token lives in a cookie. */
interface SignedPayload {
  v: 1
  p: SignedTokenPurpose
  s: string
  i: number
  e: number
  n: string
  d?: Record<string, string | number | boolean>
}

export interface SignedTokenClaims {
  purpose: SignedTokenPurpose
  subject: string
  issuedAt: Date
  expiresAt: Date
  data: Record<string, string | number | boolean>
}

export type SignedTokenVerdict =
  | { ok: true; claims: SignedTokenClaims }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'wrong_purpose' | 'expired' }

export interface TokenSigner {
  sign(params: {
    purpose: SignedTokenPurpose
    subject: string
    ttlSeconds: number
    now?: Date
    data?: Record<string, string | number | boolean>
  }): string
  verify(token: string, params: { purpose: SignedTokenPurpose; now?: Date }): SignedTokenVerdict
}

/**
 * Build a signer over an explicit secret.
 *
 * A factory rather than a module reading `getConfig()`, so tests never need a
 * configured environment and so the pickup-code signer and the session signer can be
 * given different keys without either module knowing about the other.
 */
export function createTokenSigner(secret: string | Buffer): TokenSigner {
  return {
    sign(params) {
      const now = params.now ?? new Date()
      const issued = Math.floor(now.getTime() / 1000)
      const payload: SignedPayload = {
        v: 1,
        p: params.purpose,
        s: params.subject,
        i: issued,
        e: issued + params.ttlSeconds,
        // So two tokens minted in the same second are not the same string. Without
        // it, a re-issued CSRF token would be indistinguishable from a replay of the
        // old one.
        n: randomBytes(8).toString('base64url'),
        ...(params.data ? { d: params.data } : {}),
      }

      const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
      return `${encoded}${COMPOSITE_SEPARATOR}${hmacSha256Base64Url(secret, encoded)}`
    },

    verify(token, params) {
      if (typeof token !== 'string') return { ok: false, reason: 'malformed' }

      const parts = token.split(COMPOSITE_SEPARATOR)
      if (parts.length !== 2) return { ok: false, reason: 'malformed' }

      const [encoded, signature] = parts as [string, string]
      if (encoded === '' || signature === '') return { ok: false, reason: 'malformed' }

      // Signature first, before anything inside the payload is read. Every field in
      // there is attacker-controlled until this passes, including the expiry.
      if (!verifySignature(hmacSha256Base64Url(secret, encoded), signature)) {
        return { ok: false, reason: 'bad_signature' }
      }

      const payload = decodePayload(encoded)
      if (payload === null) return { ok: false, reason: 'malformed' }
      if (payload.p !== params.purpose) return { ok: false, reason: 'wrong_purpose' }

      const now = params.now ?? new Date()
      // Closed boundary: at `e` the token is spent. Matches how expiry is treated
      // everywhere else in the codebase.
      if (payload.e * 1000 <= now.getTime()) return { ok: false, reason: 'expired' }

      return {
        ok: true,
        claims: {
          purpose: payload.p,
          subject: payload.s,
          issuedAt: new Date(payload.i * 1000),
          expiresAt: new Date(payload.e * 1000),
          data: payload.d ?? {},
        },
      }
    },
  }
}

function decodePayload(encoded: string): SignedPayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  // Deliberately `unknown`-valued rather than `Partial<SignedPayload>`: this is attacker-
  // controlled JSON, so nothing about its shape may be assumed while it is being checked.
  // Typing `p` as `SignedTokenPurpose` here would make the emptiness check dead code.
  const candidate = parsed as Record<string, unknown>

  if (candidate.v !== 1) return null
  if (typeof candidate.p !== 'string' || candidate.p === '') return null
  if (typeof candidate.s !== 'string') return null
  if (typeof candidate.i !== 'number' || typeof candidate.e !== 'number') return null
  if (!Number.isFinite(candidate.i) || !Number.isFinite(candidate.e)) return null
  if (typeof candidate.n !== 'string') return null

  // The purpose is still only known to be a non-empty string; `verify` compares it with
  // the expected purpose and returns `wrong_purpose` when it does not match, so an
  // invented value cannot pass as a real one.
  return candidate as unknown as SignedPayload
}

// ── Ready-made shapes ───────────────────────────────────────────────────────

/**
 * How long a half-completed login stays half-completed.
 *
 * Five minutes: long enough to open an authenticator app and read six digits, short
 * enough that a token left in a URL or a proxy log is useless by the time anyone
 * finds it.
 */
export const MFA_TOKEN_TTL_SECONDS = 300

/**
 * The CSRF token's lifetime.
 *
 * Twelve hours rather than the session's full length, so a token captured from a page
 * that stayed open overnight cannot be replayed the next morning. The client re-fetches
 * it; the cost of being wrong is one retried mutation, not a sign-out.
 */
export const CSRF_TOKEN_TTL_SECONDS = 12 * 60 * 60

/**
 * A CSRF token bound to the session it was issued for.
 *
 * The binding is the point. A double-submit check on an unbound value only proves the
 * caller could read its own cookie — which a subdomain, or anyone who can set a
 * cookie on the parent domain, can also do. Binding it to the session id means a
 * token minted for someone else's session fails even when both halves match.
 */
export function mintCsrfToken(signer: TokenSigner, sessionId: string, now?: Date): string {
  return signer.sign({
    purpose: 'csrf',
    subject: sessionId,
    ttlSeconds: CSRF_TOKEN_TTL_SECONDS,
    ...(now ? { now } : {}),
  })
}

/**
 * Verify a double-submit pair.
 *
 * Both halves must be present, identical, validly signed, and bound to this session.
 * The equality check is constant-time because the cookie half is a secret the header
 * half is being compared against.
 */
export function verifyCsrfToken(
  signer: TokenSigner,
  params: { cookieValue: string | null | undefined; headerValue: string | null | undefined; sessionId: string; now?: Date },
): boolean {
  const { cookieValue, headerValue, sessionId } = params
  if (!cookieValue || !headerValue) return false
  if (!verifySignature(cookieValue, headerValue)) return false

  const verdict = signer.verify(cookieValue, { purpose: 'csrf', ...(params.now ? { now: params.now } : {}) })
  return verdict.ok && verdict.claims.subject === sessionId
}
