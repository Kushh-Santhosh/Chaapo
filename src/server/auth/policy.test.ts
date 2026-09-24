import { describe, expect, it } from 'vitest'

import {
  clearedCookies,
  csrfCookie,
  csrfCookieName,
  isMfaFresh,
  isSessionLive,
  refreshCookie,
  refreshCookieName,
  serialiseCookie,
  sessionCookie,
  sessionCookieName,
  sessionWindow,
  shouldRotate,
  slideExpiry,
  REFRESH_COOKIE_PATH,
  SESSION_POLICY,
  type Surface,
} from './policy'

/**
 * The numbers themselves are judgement calls and will get tuned. What is tested here
 * are the invariants that must survive any tuning — the ones where being wrong is not
 * "sessions are a bit short" but "a stolen session never expires" or "a refund screen
 * opened without a second factor".
 */

const NOW = new Date('2026-08-27T10:00:00.000Z')
const SURFACES: Surface[] = ['customer', 'shop', 'admin']

describe('SESSION_POLICY', () => {
  it('never lets the idle window outlive the hard cap', () => {
    // A sliding window longer than the ceiling makes the ceiling decorative.
    for (const surface of SURFACES) {
      const policy = SESSION_POLICY[surface]
      expect(policy.idleSeconds, surface).toBeLessThanOrEqual(policy.absoluteSeconds)
      expect(policy.rotateAfterSeconds, surface).toBeLessThanOrEqual(policy.idleSeconds)
    }
  })

  it('requires a second factor to hold an admin session at all', () => {
    // §14 calls this mandatory. An admin can issue refunds and read other people's
    // personal data; a password alone must not be enough to be one.
    expect(SESSION_POLICY.admin.mfaRequired).toBe(true)
  })

  it('gives admins the shortest life and customers the longest', () => {
    expect(SESSION_POLICY.admin.absoluteSeconds).toBeLessThan(SESSION_POLICY.shop.absoluteSeconds)
    expect(SESSION_POLICY.shop.absoluteSeconds).toBeLessThan(SESSION_POLICY.customer.absoluteSeconds)
    expect(SESSION_POLICY.admin.idleSeconds).toBeLessThan(SESSION_POLICY.shop.idleSeconds)
  })

  it('signs the shop dashboard out overnight', () => {
    // It runs on a counter machine that customers stand at and staff walk away from.
    expect(SESSION_POLICY.shop.idleSeconds).toBeLessThanOrEqual(12 * 60 * 60)
  })

  it('keeps step-up freshness far shorter than any session', () => {
    // A session six hours old is fine for reading an order and not fine for moving
    // money. If these were equal, "step up" would mean nothing.
    for (const surface of SURFACES) {
      const policy = SESSION_POLICY[surface]
      expect(policy.mfaFreshnessSeconds, surface).toBeLessThan(policy.absoluteSeconds)
    }
  })
})

describe('sessionWindow', () => {
  it('sets both deadlines from the issue time', () => {
    const window = sessionWindow({ surface: 'admin', now: NOW })
    expect(window.expiresAt.toISOString()).toBe('2026-08-27T10:30:00.000Z')
    expect(window.absoluteExpiresAt.toISOString()).toBe('2026-08-27T22:00:00.000Z')
  })

  it('clamps a misconfigured idle window to the cap', () => {
    // An operator override longer than the ceiling is a misconfiguration, not a
    // licence to outlive it.
    const window = sessionWindow({
      surface: 'admin',
      now: NOW,
      idleSeconds: 400 * 24 * 60 * 60,
      absoluteSeconds: 3600,
    })
    expect(window.expiresAt.getTime()).toBe(window.absoluteExpiresAt.getTime())
  })

  it('honours an operator override', () => {
    const window = sessionWindow({ surface: 'shop', now: NOW, idleSeconds: 60, absoluteSeconds: 600 })
    expect(window.expiresAt.toISOString()).toBe('2026-08-27T10:01:00.000Z')
    expect(window.absoluteExpiresAt.toISOString()).toBe('2026-08-27T10:10:00.000Z')
  })
})

describe('slideExpiry', () => {
  it('pushes the idle deadline forward on use', () => {
    const later = new Date(NOW.getTime() + 20 * 60_000)
    const absolute = new Date(NOW.getTime() + 12 * 60 * 60_000)
    expect(slideExpiry({ surface: 'admin', now: later, absoluteExpiresAt: absolute }).toISOString()).toBe(
      '2026-08-27T10:50:00.000Z',
    )
  })

  it('never pushes past the hard cap', () => {
    // The invariant the whole function exists for: without the clamp, a session used
    // once a day never expires, and `absolute_expires_at` is a column that does
    // nothing.
    const nearTheEnd = new Date(NOW.getTime() + 11 * 60 * 60_000 + 55 * 60_000)
    const absolute = new Date(NOW.getTime() + 12 * 60 * 60_000)
    const slid = slideExpiry({ surface: 'admin', now: nearTheEnd, absoluteExpiresAt: absolute })
    expect(slid.getTime()).toBe(absolute.getTime())
  })

  it('does not resurrect a session past its cap', () => {
    const past = new Date(NOW.getTime() - 1000)
    expect(slideExpiry({ surface: 'admin', now: NOW, absoluteExpiresAt: past }).getTime()).toBe(
      past.getTime(),
    )
  })
})

describe('isSessionLive', () => {
  const absolute = new Date(NOW.getTime() + 3_600_000)
  const idle = new Date(NOW.getTime() + 600_000)

  it('is live inside both deadlines', () => {
    expect(isSessionLive({ now: NOW, expiresAt: idle, absoluteExpiresAt: absolute })).toBe(true)
  })

  it('dies on either deadline, at the boundary', () => {
    expect(isSessionLive({ now: idle, expiresAt: idle, absoluteExpiresAt: absolute })).toBe(false)
    expect(isSessionLive({ now: absolute, expiresAt: absolute, absoluteExpiresAt: absolute })).toBe(false)
  })

  it('dies the moment it is revoked, whatever the deadlines say', () => {
    // "Sign out this device" has to take effect now, not at the next expiry. This is
    // the property that a self-contained token could not have given us.
    expect(
      isSessionLive({ now: NOW, expiresAt: idle, absoluteExpiresAt: absolute, revokedAt: NOW }),
    ).toBe(false)
  })

  it('treats a null revocation as not revoked', () => {
    expect(
      isSessionLive({ now: NOW, expiresAt: idle, absoluteExpiresAt: absolute, revokedAt: null }),
    ).toBe(true)
  })
})

describe('shouldRotate', () => {
  it('rotates once the token reaches its age', () => {
    const issued = NOW
    const policy = SESSION_POLICY.admin.rotateAfterSeconds

    expect(
      shouldRotate({ surface: 'admin', now: new Date(NOW.getTime() + (policy - 1) * 1000), tokenIssuedAt: issued }),
    ).toBe(false)
    expect(
      shouldRotate({ surface: 'admin', now: new Date(NOW.getTime() + policy * 1000), tokenIssuedAt: issued }),
    ).toBe(true)
  })

  it('rotates an admin token far sooner than a customer one', () => {
    const at = new Date(NOW.getTime() + 10 * 60_000)
    expect(shouldRotate({ surface: 'admin', now: at, tokenIssuedAt: NOW })).toBe(true)
    expect(shouldRotate({ surface: 'customer', now: at, tokenIssuedAt: NOW })).toBe(false)
  })
})

describe('isMfaFresh', () => {
  it('is fresh inside the window', () => {
    const satisfied = new Date(NOW.getTime() - 5 * 60_000)
    expect(isMfaFresh({ surface: 'admin', mfaSatisfiedAt: satisfied, now: NOW })).toBe(true)
  })

  it('goes stale on the boundary', () => {
    const window = SESSION_POLICY.admin.mfaFreshnessSeconds * 1000
    expect(
      isMfaFresh({ surface: 'admin', mfaSatisfiedAt: new Date(NOW.getTime() - window + 1), now: NOW }),
    ).toBe(true)
    expect(
      isMfaFresh({ surface: 'admin', mfaSatisfiedAt: new Date(NOW.getTime() - window), now: NOW }),
    ).toBe(false)
  })

  it('treats never-satisfied as not fresh', () => {
    // The inversion to be afraid of: a missing timestamp reading as "no MFA needed"
    // opens the refund screen to a session that never presented a code.
    for (const missing of [null, undefined]) {
      expect(isMfaFresh({ surface: 'admin', mfaSatisfiedAt: missing, now: NOW }), String(missing)).toBe(
        false,
      )
    }
  })

  it('treats a future timestamp as not fresh', () => {
    // A clock skew or a forged row. Neither is evidence that anyone typed a code.
    expect(
      isMfaFresh({ surface: 'admin', mfaSatisfiedAt: new Date(NOW.getTime() + 60_000), now: NOW }),
    ).toBe(false)
  })

  it('honours an operator override', () => {
    const satisfied = new Date(NOW.getTime() - 60_000)
    expect(isMfaFresh({ surface: 'admin', mfaSatisfiedAt: satisfied, now: NOW, freshnessSeconds: 30 })).toBe(
      false,
    )
    expect(isMfaFresh({ surface: 'admin', mfaSatisfiedAt: satisfied, now: NOW, freshnessSeconds: 120 })).toBe(
      true,
    )
  })
})

describe('cookie names', () => {
  it('are separate per surface, so both sessions can coexist', () => {
    // Shop owners order prints from other shops and support staff reproduce customer
    // bugs. One shared name would make each sign-in silently end the other.
    const names = SURFACES.map((surface) => sessionCookieName(surface, true))
    expect(new Set(names).size).toBe(SURFACES.length)
  })

  it('take the __Host- prefix on https, so no subdomain can overwrite them', () => {
    expect(sessionCookieName('admin', true)).toBe('__Host-chaapo_admin_session')
    expect(csrfCookieName('admin', true)).toBe('__Host-chaapo_admin_csrf')
  })

  it('drop the prefix on plain http, because the browser would refuse the cookie', () => {
    expect(sessionCookieName('admin', false)).toBe('chaapo_admin_session')
    expect(csrfCookieName('admin', false)).toBe('chaapo_admin_csrf')
  })

  it('use __Secure- for the refresh cookie, which cannot be __Host-', () => {
    // `__Host-` demands path `/`, and the refresh cookie's narrow path is worth more.
    expect(refreshCookieName('admin', true)).toBe('__Secure-chaapo_admin_refresh')
  })
})

describe('sessionCookie', () => {
  it('is httpOnly, secure and SameSite=Lax', () => {
    const cookie = sessionCookie({ surface: 'customer', token: 'abc.def', secure: true, maxAgeSeconds: 600 })
    expect(cookie.httpOnly).toBe(true)
    expect(cookie.secure).toBe(true)
    expect(cookie.path).toBe('/')
    // Lax, not Strict: the payment aggregator returns the customer by a top-level
    // navigation from its own origin, and Strict would withhold the cookie — landing
    // them on a sign-in screen one second after paying.
    expect(cookie.sameSite).toBe('lax')
  })

  it('refuses a value that would have to be encoded', () => {
    // A token that changes shape in transit is a bug that only appears for some
    // tokens, so this fails loudly instead.
    expect(() =>
      sessionCookie({ surface: 'customer', token: 'has space', secure: true, maxAgeSeconds: 60 }),
    ).toThrow()
    expect(() =>
      sessionCookie({ surface: 'customer', token: 'has;semicolon', secure: true, maxAgeSeconds: 60 }),
    ).toThrow()
  })

  it('accepts the composite token shape', () => {
    const token = '0192f3a4-5b6c-7d8e-9f01-234567890abc.Zm9vYmFyLWJheg_-1234567890abcdefghijk'
    expect(() =>
      sessionCookie({ surface: 'customer', token, secure: true, maxAgeSeconds: 60 }),
    ).not.toThrow()
  })
})

describe('refreshCookie', () => {
  it('is scoped to the auth routes and nowhere else', () => {
    // Every discovery search, upload and SSE stream then carries no refresh token at
    // all — which is what makes its much longer life acceptable.
    const cookie = refreshCookie({ surface: 'shop', token: 'abc.def', secure: true, maxAgeSeconds: 600 })
    expect(cookie.path).toBe(REFRESH_COOKIE_PATH)
    expect(cookie.httpOnly).toBe(true)
  })
})

describe('csrfCookie', () => {
  it('is readable by scripts, on purpose', () => {
    // Double-submit needs the page to echo the value in a header. Safe only because
    // the token is signed and bound to the session id.
    const cookie = csrfCookie({ surface: 'shop', token: 'abc.def', secure: true, maxAgeSeconds: 600 })
    expect(cookie.httpOnly).toBe(false)
    expect(cookie.secure).toBe(true)
  })
})

describe('clearedCookies', () => {
  it('clears the refresh cookie on its own path', () => {
    // Set with a path and cleared without it, the browser keeps it — and a sign-out
    // button that leaves a live refresh token does not sign anyone out.
    const cleared = clearedCookies('shop', true)
    const refresh = cleared.find((cookie) => cookie.name.includes('refresh'))
    expect(refresh?.path).toBe(REFRESH_COOKIE_PATH)
  })

  it('clears every cookie the surface sets', () => {
    const cleared = clearedCookies('admin', true)
    expect(cleared.map((cookie) => cookie.name).sort()).toEqual(
      [
        csrfCookieName('admin', true),
        refreshCookieName('admin', true),
        sessionCookieName('admin', true),
      ].sort(),
    )
    expect(cleared.every((cookie) => cookie.maxAge === 0 && cookie.value === '')).toBe(true)
  })
})

describe('serialiseCookie', () => {
  it('renders the attributes a browser needs', () => {
    const header = serialiseCookie(
      sessionCookie({ surface: 'admin', token: 'abc.def', secure: true, maxAgeSeconds: 1800 }),
      NOW,
    )
    expect(header).toBe(
      '__Host-chaapo_admin_session=abc.def; Path=/; Max-Age=1800; ' +
        'Expires=Thu, 27 Aug 2026 10:30:00 GMT; HttpOnly; Secure; SameSite=Lax',
    )
  })

  it('renders a cleared cookie so a browser drops it immediately', () => {
    // Max-Age=0 and an epoch Expires: two ways of saying the same thing, because a
    // sign-out that only half-clears a cookie is a sign-out that does not work.
    for (const cookie of clearedCookies('admin', true)) {
      const header = serialiseCookie(cookie, NOW)
      expect(header, cookie.name).toContain('Max-Age=0')
      expect(header, cookie.name).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT')
    }
  })

  it('omits Secure in dev, where the browser would reject it over http', () => {
    const header = serialiseCookie(
      sessionCookie({ surface: 'customer', token: 'abc.def', secure: false, maxAgeSeconds: 60 }),
      NOW,
    )
    expect(header).not.toContain('Secure')
    expect(header).toContain('HttpOnly')
  })
})
