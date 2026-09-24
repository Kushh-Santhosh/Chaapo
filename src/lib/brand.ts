/**
 * Brand strings, isolated in one file.
 *
 * The PRD supplies the name and the promise line; everything else here is a
 * build-time default chosen so the product reads as finished. Nothing in the
 * application hardcodes these strings — change them here and the whole surface
 * follows. (IMPLEMENTATION_PLAN.md §23.)
 */
export const brand = {
  name: 'Chaapo',
  /** The core promise, verbatim from the PRD. */
  promise: 'Send your print job before you reach the shop.',
  promiseSecondary: 'Skip the queue.',
  tagline: 'Print without the queue',
  description:
    'Send your print job to a verified shop near you, pay online, and collect when it says Ready. No queue, no pen drive, no “come back in an hour”.',
  legalEntity: 'Chaapo Technologies Private Limited',
  supportEmail: 'support@chaapo.in',
  grievanceEmail: 'grievance@chaapo.in',
  /** Displayed in the customer footer and on the invoice. */
  addressLines: ['Chaapo Technologies Private Limited', 'Bengaluru, Karnataka, India'],
  domain: 'chaapo.in',
} as const

/** Surface labels, so the three consoles stay consistently named everywhere. */
export const surfaceNames = {
  customer: 'Chaapo',
  shop: 'Chaapo for Shops',
  admin: 'Chaapo Console',
} as const
