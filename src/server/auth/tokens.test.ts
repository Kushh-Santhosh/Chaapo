import { describe, expect, it } from 'vitest'

import { newId } from '../../lib/ids'
import { hmacSha256Base64Url } from '../core/crypto'
import {
  createTokenSigner,
  hashTokenSecret,
  mintCompositeToken,
  mintCsrfToken,
  parseCompositeToken,
  tokenSecretMatches,
  verifyCsrfToken,
  CSRF_TOKEN_TTL_SECONDS,
  MFA_TOKEN_TTL_SECONDS,
} from './tokens'

/**
 * Two shapes, two sets of rules.
 *
 * For composite tokens the property worth testing is the one they exist for: a
 * rotated refresh token must still identify its own session, because that is what
 * makes "this was stolen, kill the family" possible at all.
 *
 * For signed tokens it is the order of checks. Anything read out of a payload before
 * the signature is verified is attacker-controlled — including the expiry, which is
 * the field an attacker would edit first.
 */

const SECRET = 'test-session-signing-secret'
const NOW = new Date('2026-08-27T10:00:00.000Z')

describe('mintCompositeToken', () => {
  it('is the row id and a secret, joined', () => {
    const id = newId()
    const minted = mintCompositeToken(id)
    expect(minted.token).toBe(`${id}.${minted.secret}`)
    expect(minted.id).toBe(id)
  })

  it('mints its own id when there is not one yet', () => {
    const minted = mintCompositeToken()
    expect(parseCompositeToken(minted.token)?.id).toBe(minted.id)
  })

  it('is 256 bits of secret, every time a different one', () => {
    const secrets = new Set(Array.from({ length: 200 }, () => mintCompositeToken().secret))
    expect(secrets.size).toBe(200)
    // 32 bytes of base64url.
    expect([...secrets].every((secret) => /^[A-Za-z0-9_-]{43}$/.test(secret))).toBe(true)
  })

  it('stores a digest, not the secret', () => {
    const minted = mintCompositeToken()
    expect(minted.hash).not.toContain(minted.secret)
    expect(minted.hash).toBe(hashTokenSecret(minted.secret))
  })
})

describe('parseCompositeToken', () => {
  it('splits a token it minted', () => {
    const minted = mintCompositeToken()
    expect(parseCompositeToken(minted.token)).toEqual({ id: minted.id, secret: minted.secret })
  })

  it('identifies the session even when the secret is stale', () => {
    // The whole reason for this shape. After rotation the secret no longer matches,
    // but the id still resolves — so the reused token can be traced to its family
    // and the family revoked. A hash lookup would find nothing and the theft would
    // look like a typo.
    const minted = mintCompositeToken()
    const rotated = mintCompositeToken(minted.id)

    const parsed = parseCompositeToken(minted.token)
    expect(parsed?.id).toBe(minted.id)
    expect(tokenSecretMatches(rotated.hash, parsed?.secret ?? '')).toBe(false)
  })

  it('refuses anything that is not exactly an id and a secret', () => {
    const minted = mintCompositeToken()
    const bad = [
      '',
      '.',
      minted.id,
      minted.secret,
      `.${minted.secret}`,
      `${minted.id}.`,
      // An extra part: an attacker appending to a stolen token.
      `${minted.token}.extra`,
      // Not a uuid, so it must never reach a query.
      `not-a-uuid.${minted.secret}`,
      `1 OR 1=1.${minted.secret}`,
      // Truncated secret — no reason to spend a hash finding out.
      `${minted.id}.${minted.secret.slice(0, 42)}`,
      `${minted.id}.${minted.secret}x`,
      `${minted.id}.${minted.secret.slice(0, 42)}+`,
    ]
    for (const token of bad) {
      expect(parseCompositeToken(token), JSON.stringify(token)).toBeNull()
    }
  })
})

describe('tokenSecretMatches', () => {
  it('accepts the right secret and nothing else', () => {
    const minted = mintCompositeToken()
    expect(tokenSecretMatches(minted.hash, minted.secret)).toBe(true)
    expect(tokenSecretMatches(minted.hash, mintCompositeToken().secret)).toBe(false)
    expect(tokenSecretMatches(minted.hash, '')).toBe(false)
    expect(tokenSecretMatches('', minted.secret)).toBe(false)
  })

  it('is stable across calls, so the digest can be an index', () => {
    const minted = mintCompositeToken()
    expect(hashTokenSecret(minted.secret)).toBe(hashTokenSecret(minted.secret))
  })
})

describe('createTokenSigner', () => {
  const signer = createTokenSigner(SECRET)

  it('round-trips its claims', () => {
    const token = signer.sign({ purpose: 'mfa', subject: 'user-1', ttlSeconds: 300, now: NOW })
    const verdict = signer.verify(token, { purpose: 'mfa', now: NOW })

    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.claims.subject).toBe('user-1')
    expect(verdict.claims.purpose).toBe('mfa')
    expect(verdict.claims.issuedAt.toISOString()).toBe('2026-08-27T10:00:00.000Z')
    expect(verdict.claims.expiresAt.toISOString()).toBe('2026-08-27T10:05:00.000Z')
    expect(verdict.claims.data).toEqual({})
  })

  it('carries the caller’s data through', () => {
    const token = signer.sign({
      purpose: 'mfa',
      subject: 'user-1',
      ttlSeconds: 300,
      now: NOW,
      data: { surface: 'admin', shopId: 'shop-9', staff: true, attempts: 1 },
    })
    const verdict = signer.verify(token, { purpose: 'mfa', now: NOW })
    expect(verdict.ok && verdict.claims.data).toEqual({
      surface: 'admin',
      shopId: 'shop-9',
      staff: true,
      attempts: 1,
    })
  })

  it('is different every time even within the same second', () => {
    // Otherwise a re-issued token is byte-identical to a replay of the old one, and
    // nothing downstream can tell them apart.
    const a = signer.sign({ purpose: 'csrf', subject: 'session-1', ttlSeconds: 60, now: NOW })
    const b = signer.sign({ purpose: 'csrf', subject: 'session-1', ttlSeconds: 60, now: NOW })
    expect(a).not.toBe(b)
  })

  it('rejects a token signed with another key', () => {
    const other = createTokenSigner('a-different-secret')
    const token = other.sign({ purpose: 'mfa', subject: 'user-1', ttlSeconds: 300, now: NOW })
    expect(signer.verify(token, { purpose: 'mfa', now: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
  })

  it('rejects a tampered payload', () => {
    const token = signer.sign({ purpose: 'mfa', subject: 'user-1', ttlSeconds: 300, now: NOW })
    const [encoded, signature] = token.split('.') as [string, string]

    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    // Promote yourself to somebody else and give yourself a year.
    const forged = Buffer.from(
      JSON.stringify({ ...payload, s: 'user-2', e: payload.e + 31_536_000 }),
      'utf8',
    ).toString('base64url')

    expect(signer.verify(`${forged}.${signature}`, { purpose: 'mfa', now: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
  })

  it('checks the signature before it reads the expiry', () => {
    // The ordering rule. An unsigned token whose payload claims to be expired must
    // be reported as unsigned — reporting `expired` would mean the expiry was read,
    // and therefore trusted, before it was verified.
    const stale = Buffer.from(
      JSON.stringify({ v: 1, p: 'mfa', s: 'user-1', i: 0, e: 1, n: 'x' }),
      'utf8',
    ).toString('base64url')
    expect(signer.verify(`${stale}.not-a-real-signature`, { purpose: 'mfa', now: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
  })

  it('refuses a token minted for another purpose', () => {
    // A CSRF token is readable by any script on the page. If it also verified as an
    // MFA token, reading it would skip the second factor.
    const csrf = signer.sign({ purpose: 'csrf', subject: 'user-1', ttlSeconds: 300, now: NOW })
    expect(signer.verify(csrf, { purpose: 'mfa', now: NOW })).toEqual({
      ok: false,
      reason: 'wrong_purpose',
    })
    expect(signer.verify(csrf, { purpose: 'csrf', now: NOW }).ok).toBe(true)
  })

  it('expires on the boundary, not eventually', () => {
    const token = signer.sign({ purpose: 'mfa', subject: 'user-1', ttlSeconds: 300, now: NOW })
    const justInside = new Date(NOW.getTime() + 299_999)
    const exactly = new Date(NOW.getTime() + 300_000)

    expect(signer.verify(token, { purpose: 'mfa', now: justInside }).ok).toBe(true)
    expect(signer.verify(token, { purpose: 'mfa', now: exactly })).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('rejects malformed input without throwing', () => {
    for (const token of [
      '',
      '.',
      'onepart',
      'too.many.parts',
      '.signature',
      'payload.',
      `${Buffer.from('not json', 'utf8').toString('base64url')}.x`,
    ]) {
      const verdict = signer.verify(token, { purpose: 'mfa', now: NOW })
      expect(verdict.ok, JSON.stringify(token)).toBe(false)
    }
  })

  it('rejects a correctly signed payload of the wrong shape', () => {
    // A future version, or a payload with a field stripped. Signed with the real key,
    // so the only thing wrong is the shape — and all of them must fail closed rather
    // than be read with fields missing.
    for (const payload of [
      { v: 2, p: 'mfa', s: 'user-1', i: 0, e: 9_999_999_999, n: 'x' },
      { p: 'mfa', s: 'user-1', i: 0, e: 9_999_999_999, n: 'x' },
      { v: 1, s: 'user-1', i: 0, e: 9_999_999_999, n: 'x' },
      { v: 1, p: 'mfa', i: 0, e: 9_999_999_999, n: 'x' },
      { v: 1, p: 'mfa', s: 'user-1', i: 0, e: 'later', n: 'x' },
      { v: 1, p: 'mfa', s: 'user-1', i: 0, e: 9_999_999_999 },
      ['not', 'an', 'object'],
      null,
    ]) {
      expect(signer.verify(signPayload(payload), { purpose: 'mfa', now: NOW }), JSON.stringify(payload)).toEqual(
        { ok: false, reason: 'malformed' },
      )
    }
  })
})

/** Sign a hand-built payload the way `createTokenSigner` does, with the same key. */
function signPayload(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${encoded}.${hmacSha256Base64Url(SECRET, encoded)}`
}

describe('mfa token', () => {
  it('lasts long enough to read an authenticator app and no longer', () => {
    // Long enough to open the app; short enough that a token left in a proxy log is
    // useless by the time anyone reads it.
    expect(MFA_TOKEN_TTL_SECONDS).toBe(300)
  })
})

describe('csrf token', () => {
  const signer = createTokenSigner(SECRET)

  it('accepts a matching pair bound to the session', () => {
    const token = mintCsrfToken(signer, 'session-1', NOW)
    expect(
      verifyCsrfToken(signer, {
        cookieValue: token,
        headerValue: token,
        sessionId: 'session-1',
        now: NOW,
      }),
    ).toBe(true)
  })

  it('rejects a token issued for a different session', () => {
    // The binding is the point. Without it, a double-submit check only proves the
    // caller could read its own cookie — which anyone able to set a cookie on the
    // parent domain can also do.
    const token = mintCsrfToken(signer, 'session-1', NOW)
    expect(
      verifyCsrfToken(signer, {
        cookieValue: token,
        headerValue: token,
        sessionId: 'session-2',
        now: NOW,
      }),
    ).toBe(false)
  })

  it('rejects a pair that does not match', () => {
    const cookie = mintCsrfToken(signer, 'session-1', NOW)
    const header = mintCsrfToken(signer, 'session-1', NOW)
    expect(
      verifyCsrfToken(signer, {
        cookieValue: cookie,
        headerValue: header,
        sessionId: 'session-1',
        now: NOW,
      }),
    ).toBe(false)
  })

  it('rejects a missing half', () => {
    const token = mintCsrfToken(signer, 'session-1', NOW)
    for (const missing of [null, undefined, '']) {
      expect(
        verifyCsrfToken(signer, {
          cookieValue: missing,
          headerValue: token,
          sessionId: 'session-1',
          now: NOW,
        }),
        `cookie ${String(missing)}`,
      ).toBe(false)
      expect(
        verifyCsrfToken(signer, {
          cookieValue: token,
          headerValue: missing,
          sessionId: 'session-1',
          now: NOW,
        }),
        `header ${String(missing)}`,
      ).toBe(false)
    }
  })

  it('rejects an unsigned value even when both halves agree', () => {
    // An attacker who can set a cookie can make both halves match; only the
    // signature makes that useless.
    expect(
      verifyCsrfToken(signer, {
        cookieValue: 'attacker-chosen',
        headerValue: 'attacker-chosen',
        sessionId: 'session-1',
        now: NOW,
      }),
    ).toBe(false)
  })

  it('stops working after twelve hours', () => {
    const token = mintCsrfToken(signer, 'session-1', NOW)
    const nextMorning = new Date(NOW.getTime() + (CSRF_TOKEN_TTL_SECONDS + 1) * 1000)
    expect(
      verifyCsrfToken(signer, {
        cookieValue: token,
        headerValue: token,
        sessionId: 'session-1',
        now: nextMorning,
      }),
    ).toBe(false)
  })
})
