/**
 * Session lifetimes and cookie attributes, per surface.
 *
 * Pure data and pure functions over plain numbers — no config lookup, no clock, no
 * `Request`. The numbers below are defaults; an operator can override them through
 * `platform_config`, and every function here takes the effective value as an argument
 * so the override path and the default path run identical code.
 *
 * The three surfaces get genuinely different treatment because the cost of being
 * wrong differs by orders of magnitude:
 *
 *   • A **customer** signed out on their phone abandons the order. There is nothing
 *     behind that session but their own orders, so it is long-lived and slides.
 *   • A **shop** dashboard runs on a counter machine that staff share and walk away
 *     from. It signs itself out overnight.
 *   • An **admin** session can issue refunds, release payouts and read other people's
 *     personal data. It is short, it is capped hard, and it requires a second factor
 *     to exist at all (§14).
 */

import type { Surface } from '../core/rbac'

/**
 * Defined once, in `core/rbac.ts`, so the session policy and the capability matrix
 * cannot disagree about what a surface is. Re-exported because almost everything that
 * needs a session policy needs the surface too, and type-only, so this module still
 * pulls in nothing at runtime.
 */
export type { Surface }

export interface SurfaceSessionPolicy {
  /**
   * How long a session survives without being used. Slides forward on each request,
   * never past `absoluteSeconds`. This is `sessions.expires_at`.
   */
  idleSeconds: number
  /**
   * The hard ceiling from issue, regardless of activity. This is
   * `sessions.absolute_expires_at`, and nothing extends it — re-authentication mints
   * a new session rather than pushing this out, so "how long can a stolen session
   * possibly live" has an answer.
   */
  absoluteSeconds: number
  /**
   * How old the session token may get before a request silently rotates it.
   *
   * The session token travels on every request; the refresh token travels only to
   * `/api/v1/auth`. Rotating on this cadence bounds how long a token captured from a
   * request log or a shared proxy stays useful, without asking the user to do
   * anything.
   */
  rotateAfterSeconds: number
  /** Whether a session on this surface may exist at all without a second factor. */
  mfaRequired: boolean
  /**
   * How recently the second factor must have been satisfied for a step-up action
   * (refunds, payout release, bank-detail changes, bulk PII export).
   *
   * Separate from the session's own lifetime: a session that has been open for six
   * hours is fine for reading an order, and not fine for moving money.
   */
  mfaFreshnessSeconds: number
}

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const SESSION_POLICY: Record<Surface, SurfaceSessionPolicy> = {
  customer: {
    // A person who ordered prints last month should open the app and still be signed
    // in. Re-authenticating costs an SMS we pay for and a step most people abandon.
    idleSeconds: 30 * DAY,
    absoluteSeconds: 180 * DAY,
    rotateAfterSeconds: 1 * DAY,
    mfaRequired: false,
    mfaFreshnessSeconds: 15 * MINUTE,
  },
  shop: {
    // Twelve hours: the dashboard is signed in through a working day and signed out
    // by the next morning, because the machine it runs on sits on a counter that
    // customers stand at.
    idleSeconds: 12 * HOUR,
    absoluteSeconds: 30 * DAY,
    rotateAfterSeconds: 30 * MINUTE,
    mfaRequired: false,
    mfaFreshnessSeconds: 15 * MINUTE,
  },
  admin: {
    idleSeconds: 30 * MINUTE,
    // Half a day, so an admin session cannot outlive the shift that opened it.
    absoluteSeconds: 12 * HOUR,
    rotateAfterSeconds: 5 * MINUTE,
    mfaRequired: true,
    mfaFreshnessSeconds: 15 * MINUTE,
  },
}

export interface SessionWindow {
  /** `sessions.expires_at` */
  expiresAt: Date
  /** `sessions.absolute_expires_at` */
  absoluteExpiresAt: Date
}

/** The two deadlines a newly issued session gets. */
export function sessionWindow(params: {
  surface: Surface
  now: Date
  idleSeconds?: number
  absoluteSeconds?: number
}): SessionWindow {
  const policy = SESSION_POLICY[params.surface]
  const idle = params.idleSeconds ?? policy.idleSeconds
  const absolute = params.absoluteSeconds ?? policy.absoluteSeconds

  const absoluteExpiresAt = new Date(params.now.getTime() + absolute * 1000)
  const idleExpiresAt = new Date(params.now.getTime() + idle * 1000)

  return {
    // A configured idle window longer than the absolute one is a misconfiguration,
    // not a licence to outlive the cap.
    expiresAt: idleExpiresAt < absoluteExpiresAt ? idleExpiresAt : absoluteExpiresAt,
    absoluteExpiresAt,
  }
}

/**
 * The new `expires_at` after a request on a live session.
 *
 * Slides forward, clamped to the absolute deadline. The clamp is the whole reason
 * this is a function: an unclamped sliding window means a session that is used once
 * a day never expires, which is exactly the property `absolute_expires_at` exists to
 * prevent.
 */
export function slideExpiry(params: {
  surface: Surface
  now: Date
  absoluteExpiresAt: Date
  idleSeconds?: number
}): Date {
  const idle = params.idleSeconds ?? SESSION_POLICY[params.surface].idleSeconds
  const slid = new Date(params.now.getTime() + idle * 1000)
  return slid < params.absoluteExpiresAt ? slid : params.absoluteExpiresAt
}

/** Whether a session is still live. Both deadlines are closed boundaries. */
export function isSessionLive(params: {
  now: Date
  expiresAt: Date
  absoluteExpiresAt: Date
  revokedAt?: Date | null
}): boolean {
  if (params.revokedAt) return false
  const now = params.now.getTime()
  return now < params.expiresAt.getTime() && now < params.absoluteExpiresAt.getTime()
}

/** Whether this request should silently rotate the session token. */
export function shouldRotate(params: {
  surface: Surface
  now: Date
  tokenIssuedAt: Date
  rotateAfterSeconds?: number
}): boolean {
  const after = params.rotateAfterSeconds ?? SESSION_POLICY[params.surface].rotateAfterSeconds
  return params.now.getTime() - params.tokenIssuedAt.getTime() >= after * 1000
}

/**
 * Whether the second factor is recent enough for a step-up action.
 *
 * `null` means never satisfied, which is not fresh. A missing timestamp must never
 * read as "no MFA needed" — that inversion is how a refund screen ends up open to a
 * session that never presented a code.
 */
export function isMfaFresh(params: {
  surface: Surface
  mfaSatisfiedAt: Date | null | undefined
  now: Date
  freshnessSeconds?: number
}): boolean {
  if (!params.mfaSatisfiedAt) return false
  const window = params.freshnessSeconds ?? SESSION_POLICY[params.surface].mfaFreshnessSeconds
  const age = params.now.getTime() - params.mfaSatisfiedAt.getTime()
  // A timestamp in the future means a clock problem or a forged row. Neither is fresh.
  if (age < 0) return false
  return age < window * 1000
}

// ── Cookies ─────────────────────────────────────────────────────────────────

/**
 * Cookie names are per surface, so one browser can hold a customer session and a shop
 * session at once. That is not a convenience: shop owners order prints from other
 * shops, and support staff reproduce customer bugs while signed in as an admin. One
 * shared cookie name would make each sign-in silently end the other.
 *
 * The `__Host-` prefix, where the deployment is https, is enforced by the browser:
 * the cookie must be Secure, must be path `/`, and must have no Domain — so no
 * subdomain, compromised or otherwise, can overwrite it. It is dropped on plain http
 * because the prefix requires Secure and a cookie the browser refuses is worse than a
 * weaker name in dev.
 */
export function sessionCookieName(surface: Surface, secure: boolean): string {
  return `${secure ? '__Host-' : ''}chaapo_${surface}_session`
}

export function refreshCookieName(surface: Surface, secure: boolean): string {
  // `__Host-` demands path `/`, and the refresh cookie's narrow path is worth more
  // than the prefix, so it uses `__Secure-` instead.
  return `${secure ? '__Secure-' : ''}chaapo_${surface}_refresh`
}

export function csrfCookieName(surface: Surface, secure: boolean): string {
  return `${secure ? '__Host-' : ''}chaapo_${surface}_csrf`
}

/**
 * The refresh cookie is scoped to the auth routes and nowhere else.
 *
 * Every other request — every discovery search, every file upload, every SSE stream —
 * carries no refresh token at all. That single attribute is what makes the refresh
 * token's much longer life acceptable.
 */
export const REFRESH_COOKIE_PATH = '/api/v1/auth'

export interface CookieAttributes {
  name: string
  value: string
  httpOnly: boolean
  secure: boolean
  sameSite: 'lax' | 'strict' | 'none'
  path: string
  /** Seconds. 0 clears the cookie. */
  maxAge: number
}

/**
 * `SameSite=Lax`, not `Strict`, and this one is worth being explicit about.
 *
 * The payment aggregator returns the customer to us by navigating the top-level
 * window back from its own origin. Under `Strict` the browser withholds the session
 * cookie on that navigation, so the customer lands on a sign-in screen one second
 * after paying — with money taken and an order they cannot see. `Lax` sends the
 * cookie on top-level GET navigations, which is exactly that case and not the
 * cross-site POST that CSRF needs. Mutations are protected by the double-submit token
 * instead, which is where that protection belongs.
 */
const SESSION_SAME_SITE = 'lax' as const

export function sessionCookie(params: {
  surface: Surface
  token: string
  secure: boolean
  maxAgeSeconds: number
}): CookieAttributes {
  return {
    name: sessionCookieName(params.surface, params.secure),
    value: assertCookieSafe(params.token),
    httpOnly: true,
    secure: params.secure,
    sameSite: SESSION_SAME_SITE,
    path: '/',
    maxAge: params.maxAgeSeconds,
  }
}

export function refreshCookie(params: {
  surface: Surface
  token: string
  secure: boolean
  maxAgeSeconds: number
}): CookieAttributes {
  return {
    name: refreshCookieName(params.surface, params.secure),
    value: assertCookieSafe(params.token),
    httpOnly: true,
    secure: params.secure,
    sameSite: SESSION_SAME_SITE,
    path: REFRESH_COOKIE_PATH,
    maxAge: params.maxAgeSeconds,
  }
}

/**
 * The CSRF cookie, deliberately readable by scripts.
 *
 * Double-submit requires the page to echo the value in a header, which means it
 * cannot be `httpOnly`. That is safe here only because the token is signed and bound
 * to the session id (see `tokens.ts`): reading it grants nothing that reading your own
 * cookie did not already grant.
 */
export function csrfCookie(params: {
  surface: Surface
  token: string
  secure: boolean
  maxAgeSeconds: number
}): CookieAttributes {
  return {
    name: csrfCookieName(params.surface, params.secure),
    value: assertCookieSafe(params.token),
    httpOnly: false,
    secure: params.secure,
    sameSite: SESSION_SAME_SITE,
    path: '/',
    maxAge: params.maxAgeSeconds,
  }
}

/**
 * Every cookie a sign-out must clear, for one surface.
 *
 * Returned as a list rather than left to call sites, because a logout that clears the
 * session cookie and forgets the refresh cookie leaves the browser able to mint a new
 * session immediately — a sign-out button that does not sign you out.
 */
export function clearedCookies(surface: Surface, secure: boolean): CookieAttributes[] {
  return [
    clearedCookie(sessionCookieName(surface, secure), secure, '/'),
    clearedCookie(csrfCookieName(surface, secure), secure, '/'),
    // Must use the same path it was set with, or the browser keeps it.
    clearedCookie(refreshCookieName(surface, secure), secure, REFRESH_COOKIE_PATH),
  ]
}

function clearedCookie(name: string, secure: boolean, path: string): CookieAttributes {
  return {
    name,
    value: '',
    httpOnly: true,
    secure,
    sameSite: SESSION_SAME_SITE,
    path,
    maxAge: 0,
  }
}

/**
 * Render a `Set-Cookie` header value.
 *
 * The route layer normally hands `CookieAttributes` to Next's cookie store; this
 * exists for the paths that write raw headers (SSE responses, the webhook surface) and
 * so the attributes can be asserted as a string in tests.
 *
 * `Max-Age` and `Expires` are both emitted: Max-Age is authoritative in every browser
 * that matters, and Expires is what a stray corporate proxy understands.
 */
export function serialiseCookie(cookie: CookieAttributes, now: Date): string {
  const parts = [`${cookie.name}=${cookie.value}`, `Path=${cookie.path}`, `Max-Age=${cookie.maxAge}`]

  const expires = new Date(cookie.maxAge > 0 ? now.getTime() + cookie.maxAge * 1000 : 0)
  parts.push(`Expires=${expires.toUTCString()}`)

  if (cookie.httpOnly) parts.push('HttpOnly')
  if (cookie.secure) parts.push('Secure')
  parts.push(`SameSite=${cookie.sameSite === 'lax' ? 'Lax' : cookie.sameSite === 'strict' ? 'Strict' : 'None'}`)

  return parts.join('; ')
}

/**
 * Cookie values are not URL-encoded on the way out, because a token that changes shape
 * in transit is a bug that only appears for some tokens. Anything that would need
 * encoding is a programmer error here — every value this module handles is base64url
 * plus a dot — so it throws rather than silently mangling a session.
 */
function assertCookieSafe(value: string): string {
  if (!/^[A-Za-z0-9._~+/=:-]*$/.test(value)) {
    throw new Error('Cookie value contains characters that would need encoding')
  }
  return value
}
