/**
 * DEVELOPMENT / CI ONLY — the offline substitute for `fonts.ts`.
 *
 * `next/font/google` downloads the font files during the build. On a machine with no
 * egress to `fonts.googleapis.com` that is a hard compile error, which would mean the
 * build, the dev server and every browser check are unavailable for a reason that has
 * nothing to do with the product.
 *
 * So this module defines the same three CSS variables as system stacks and nothing else.
 * `next.config.ts` aliases `./fonts` here only when `CHAAPO_OFFLINE_FONTS=1`, so a
 * production build that forgets the flag gets the real faces, and a production build that
 * sets it renders in `ui-serif`/`system-ui`/`ui-monospace` — visibly wrong rather than
 * quietly wrong, which is the failure mode to prefer.
 *
 * The class itself lives in `globals.css`; a plain `.fonts-offline` rule is needed because
 * `var(--font-inter), ui-sans-serif` does not fall through to `ui-sans-serif` when the
 * variable is undefined — the whole declaration becomes invalid instead.
 */

export const fontClassName = 'fonts-offline'

/** False, so the layout can mark the document and a browser check cannot mistake this for the real thing. */
export const fontsAreReal = false
