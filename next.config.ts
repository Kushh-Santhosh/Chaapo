import { resolve } from 'node:path'

import type { NextConfig } from 'next'

/**
 * Chaapo — Next.js configuration.
 *
 * The app is a modular monolith: this single deployable serves the customer PWA,
 * the shop dashboard, the admin console and the `/api/v1` HTTP surface. The
 * background worker (`scripts/worker.ts`) imports the same domain code but runs
 * as its own process — see IMPLEMENTATION_PLAN.md §2.
 *
 * Content-Security-Policy is NOT set here: it needs a per-request nonce for
 * React's inlined flight data, so it lives in `src/middleware.ts`.
 * NFR-13, NFR-14.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  {
    key: 'Permissions-Policy',
    // Geolocation is required for nearby-shop discovery (FR-101).
    value: 'geolocation=(self), camera=(self), microphone=(), payment=(), usb=()',
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
]

/**
 * `next/font/google` downloads the font files at build time. On a build or CI machine
 * with no egress to fonts.googleapis.com that is a hard compile error in
 * `src/app/layout.tsx`, which takes the dev server and every browser check with it.
 *
 * `CHAAPO_OFFLINE_FONTS=1` swaps `src/app/fonts.ts` for `src/app/fonts.offline.ts`, which
 * defines the same three CSS variables as system stacks. Opt-in only, so a production
 * build that does not set it gets the real faces.
 */
const offlineFonts = process.env.CHAAPO_OFFLINE_FONTS === '1'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',

  ...(offlineFonts
    ? {
        webpack: (config: { resolve: { alias: Record<string, string> } }) => {
          config.resolve.alias = {
            ...config.resolve.alias,
            [resolve(import.meta.dirname, 'src/app/fonts.ts')]: resolve(
              import.meta.dirname,
              'src/app/fonts.offline.ts',
            ),
          }
          return config
        },
      }
    : {}),

  // Money is handled as integer paise via bigint; never let a build silently
  // widen or narrow that. Type + lint errors must fail the build (QUALITY BAR).
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },

  experimental: {
    // Presigned-upload finalisation posts file manifests; orders with 10 files
    // and per-file page ranges can exceed the 1 MB default.
    serverActions: { bodySizeLimit: '2mb' },
  },

  serverExternalPackages: ['pg', 'sharp', 'bullmq', 'ioredis', 'web-push', 'pdf-lib'],

  images: {
    // Shop photos are served from private object storage through our own
    // signed-URL proxy — never a public bucket URL (NFR-12).
    remotePatterns: [],
    formats: ['image/avif', 'image/webp'],
  },

  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      {
        // Signed file streams and API responses must never be cached by
        // intermediaries (NFR-12).
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, private' },
          { key: 'Pragma', value: 'no-cache' },
        ],
      },
    ]
  },
}

export default nextConfig
