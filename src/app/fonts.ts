/**
 * The three faces, loaded from Google Fonts and self-hosted by `next/font`.
 *
 * This is the production path and the default. `next/font` inlines the `@font-face`
 * rules at build time and pins a size-adjusted fallback, which matters more than usual
 * here: the customer target is a mid-range Android on 4G with a 3 s first-meaningful-paint
 * budget (NFR-02), so text must paint in the fallback and swap without reflowing.
 *
 * Because `next/font/google` fetches over the network *during the build*, a build machine
 * with no egress to `fonts.googleapis.com` cannot compile this file at all. That is what
 * `fonts.offline.ts` is for; `next.config.ts` aliases this module to it when
 * `CHAAPO_OFFLINE_FONTS=1`. Everything downstream imports `fontClassName` and never names
 * a font, so the swap is invisible past this file.
 */

import { IBM_Plex_Mono, Inter, Instrument_Serif } from 'next/font/google'

/** Editorial display face. Headlines only — never interface text, never numbers. */
const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-instrument-serif',
})

/** Interface face. Latin + latin-ext so Marathi/Hindi transliterations render. */
const inter = Inter({
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
  variable: '--font-inter',
})

/**
 * Money, pickup codes, order numbers, page counts. Tabular by default so a total that
 * changes does not shift the layout around it.
 */
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-plex-mono',
})

/** Goes on `<html>`. Defines `--font-instrument-serif`, `--font-inter`, `--font-plex-mono`. */
export const fontClassName = `${instrumentSerif.variable} ${inter.variable} ${plexMono.variable}`

/** True when the real faces are in use. Rendered as a `data-` attribute so a browser check can see it. */
export const fontsAreReal = true
