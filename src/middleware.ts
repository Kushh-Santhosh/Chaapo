/**
 * Content-Security-Policy, per request.
 *
 * This is in middleware rather than `next.config.ts` because React streams its
 * flight payload in inline `<script>` tags: a policy strict enough to be worth
 * having needs a fresh nonce on every response, and Next only wires a nonce into
 * those tags if it finds one in the request's CSP header. So the nonce is minted
 * here, put on the outgoing header *and* echoed back on the request.
 *
 * `'strict-dynamic'` is what makes this survive real life — scripts Next injects
 * from a nonced script inherit trust, so the policy does not have to enumerate
 * chunk URLs. `'unsafe-inline'` is listed only as the ignored fallback for
 * browsers that do not understand nonces; a browser that understands either
 * `nonce-…` or `strict-dynamic` discards it.
 *
 * Development gets `'unsafe-eval'`, and nothing else extra, because React Refresh
 * needs it. Production does not. NFR-13, NFR-14.
 */

import { NextResponse, type NextRequest } from 'next/server'

const NONCE_HEADER = 'x-chaapo-nonce'

function policy(nonce: string, development: boolean): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // 'strict-dynamic' + nonce; the unsafe-* entries are fallbacks, see above.
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      "'unsafe-inline'",
      ...(development ? ["'unsafe-eval'"] : []),
    ],
    // Tailwind emits a single stylesheet, but `next/font` writes an inline
    // <style> block for its @font-face rules, and styled elements set inline
    // custom properties (progress bars, the price bar). Hashing those is not
    // practical; the risk is style injection only, not script execution.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', 'https://tile.openstreetmap.org'],
    'font-src': ["'self'", 'data:'],
    // Signed uploads go straight to object storage, and SSE connects to /api.
    'connect-src': ["'self'", 'https:', ...(development ? ['ws:', 'http://localhost:*'] : [])],
    // Razorpay Checkout renders in an iframe it injects itself.
    'frame-src': ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'media-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  }

  const serialised = Object.entries(directives)
    .map(([directive, values]) => `${directive} ${values.join(' ')}`)
    .join('; ')

  // No upgrade-insecure-requests in development: localhost is http.
  return development ? serialised : `${serialised}; upgrade-insecure-requests`
}

export function middleware(request: NextRequest): NextResponse {
  const nonce = crypto.randomUUID().replaceAll('-', '')
  const development = process.env.NODE_ENV !== 'production'
  const csp = policy(nonce, development)

  // Next reads the nonce off the *request* header to nonce its own script tags.
  const headers = new Headers(request.headers)
  headers.set(NONCE_HEADER, nonce)
  headers.set('Content-Security-Policy', csp)

  const response = NextResponse.next({ request: { headers } })
  response.headers.set('Content-Security-Policy', csp)
  return response
}

export const config = {
  /**
   * Everything except static assets and the icons — a nonce on an immutable
   * `/_next/static` response would defeat caching for no security gain.
   */
  matcher: [
    '/((?!_next/static|_next/image|brand/|favicon.ico|manifest.webmanifest|sw.js|robots.txt|sitemap.xml).*)',
  ],
}
