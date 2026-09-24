/**
 * Root layout.
 *
 * Deliberately thin: it loads the three fonts, sets the document colour and
 * viewport, and renders nothing chrome-like. All three surfaces — customer PWA,
 * shop dashboard, admin console — nest their own layout beneath this one, because
 * they share a design language but share almost no furniture (§21–§23).
 *
 * Fonts are self-hosted through `next/font`, which inlines the `@font-face` rules
 * and pins a size-adjusted fallback. That matters more than usual here: the
 * customer target is a mid-range Android on 4G with a 3 s first-meaningful-paint
 * budget (NFR-02), so text must paint in the fallback and swap without reflowing
 * the page. The loading itself lives in `fonts.ts` so that a build machine without
 * egress to Google Fonts can substitute `fonts.offline.ts` — see that file.
 */

import type { Metadata, Viewport } from 'next'

import { brand } from '@/lib/brand'

import { fontClassName, fontsAreReal } from './fonts'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default: `${brand.name} — ${brand.tagline}`,
    template: `%s · ${brand.name}`,
  },
  description: brand.description,
  applicationName: brand.name,
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: brand.name },
  formatDetection: { telephone: false },
  // Order pages, the shop dashboard and the whole console are private. Indexing
  // is opted into per-page by the marketing and shop-profile routes only.
  robots: { index: false, follow: false },
  icons: {
    icon: [{ url: '/brand/icon.svg', type: 'image/svg+xml' }],
    apple: [{ url: '/brand/apple-touch-icon.png', sizes: '180x180' }],
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Zoom is left enabled: a customer reading a price breakdown or a pickup code
  // on a small screen must be able to magnify it.
  maximumScale: 5,
  themeColor: '#fbf8f3',
  // The customer PWA has a sticky bottom action bar; without this the iOS home
  // indicator overlaps it.
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en-IN"
      className={fontClassName}
      data-fonts={fontsAreReal ? 'google' : 'system-fallback'}
      suppressHydrationWarning
    >
      <body>{children}</body>
    </html>
  )
}
