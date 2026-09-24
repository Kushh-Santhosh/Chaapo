/**
 * Order state → what a human sees.
 *
 * The state machine itself is server-owned (PRD §F, enforced in the orders domain);
 * this module is only its presentation, and it lives in `src/lib` because all three
 * surfaces need it and none of them may reach into the server for a label.
 *
 * Customer and shop wording differ on purpose. `rejected` is "Shop could not take
 * this — you have been refunded" to a customer and "Declined" to the shop that
 * declined it; `payment_pending` is "Finishing payment" to the person holding the
 * phone and never shown to a shop at all, because a shop must not see an order that
 * has not been paid for.
 *
 * Every one of the twenty states appears in both maps. `Record<OrderState, …>` is
 * what makes that a compile error rather than a blank chip in production.
 */

import type { OrderState } from '@/server/db/schema/enums'

import type { BadgeTone } from '@/components/ui/badge'

export interface StatePresentation {
  label: string
  tone: BadgeTone
  /** One line of explanation, for the tracking timeline and empty states. */
  detail: string
  /** Whether something is expected to change without the user doing anything. */
  live?: boolean
}

export const CUSTOMER_STATE: Record<OrderState, StatePresentation> = {
  draft: {
    label: 'Draft',
    tone: 'neutral',
    detail: 'Not sent yet. Your files and settings are saved on this device.',
  },
  awaiting_quote: {
    label: 'Awaiting quote',
    tone: 'info',
    detail: 'The shop is checking your files and will send a price.',
    live: true,
  },
  payment_pending: {
    label: 'Finishing payment',
    tone: 'warn',
    detail: 'We are confirming your payment. This usually takes a few seconds.',
    live: true,
  },
  failed: {
    label: 'Payment failed',
    tone: 'danger',
    detail: 'No money was taken. You can try paying again — your files are still here.',
  },
  placed: {
    label: 'Sent to shop',
    tone: 'chaap',
    detail: 'Waiting for the shop to accept. You will be notified either way.',
    live: true,
  },
  accepted: {
    label: 'Accepted',
    tone: 'info',
    detail: 'The shop has your job in the queue.',
    live: true,
  },
  printing: {
    label: 'Printing',
    tone: 'info',
    detail: 'On the machine now.',
    live: true,
  },
  on_hold_file_issue: {
    label: 'Needs your attention',
    tone: 'warn',
    detail: 'The shop hit a problem with a file. Open the order to see what they need.',
  },
  ready: {
    label: 'Ready for pickup',
    tone: 'success',
    detail: 'Show your pickup code at the counter to collect.',
  },
  collected: {
    label: 'Collected',
    tone: 'success',
    detail: 'Picked up. Thanks — a rating helps the next person choose.',
  },
  settled: {
    label: 'Completed',
    tone: 'success',
    detail: 'Collected and closed.',
  },
  rejected: {
    label: 'Shop declined',
    tone: 'danger',
    detail: 'The shop could not take this job. Your payment is being refunded in full.',
  },
  auto_cancelled: {
    label: 'Cancelled',
    tone: 'neutral',
    detail: 'No shop accepted this in time, so it was cancelled and refunded in full.',
  },
  cancelled_by_customer: {
    label: 'Cancelled',
    tone: 'neutral',
    detail: 'You cancelled this order.',
  },
  cancelled_by_shop: {
    label: 'Cancelled by shop',
    tone: 'danger',
    detail: 'The shop cancelled this order. Your payment is being refunded in full.',
  },
  expired: {
    label: 'Expired',
    tone: 'neutral',
    detail: 'This was not collected in time. Contact the shop before reordering.',
  },
  refunded: {
    label: 'Refunded',
    tone: 'neutral',
    detail: 'Refunded in full. Banks usually show it within 5–7 working days.',
  },
  partially_refunded: {
    label: 'Partly refunded',
    tone: 'warn',
    detail: 'Part of this order was refunded. See the breakdown below.',
  },
  closed_no_refund: {
    label: 'Closed',
    tone: 'neutral',
    detail: 'Closed without a refund.',
  },
  disputed: {
    label: 'Under review',
    tone: 'warn',
    detail: 'We are looking into your complaint and will update you here.',
    live: true,
  },
}

export const SHOP_STATE: Record<OrderState, StatePresentation> = {
  draft: { label: 'Draft', tone: 'neutral', detail: 'Customer has not sent this yet.' },
  awaiting_quote: {
    label: 'Quote needed',
    tone: 'chaap',
    detail: 'Price this job and send the quote back.',
    live: true,
  },
  payment_pending: {
    label: 'Unpaid',
    tone: 'neutral',
    detail: 'Not yet paid — do not start work.',
  },
  failed: { label: 'Payment failed', tone: 'neutral', detail: 'Customer payment did not go through.' },
  placed: {
    label: 'New',
    tone: 'chaap',
    detail: 'Accept or decline. Auto-declines if left too long.',
    live: true,
  },
  accepted: { label: 'Accepted', tone: 'info', detail: 'In your queue, not started.' },
  printing: { label: 'Printing', tone: 'info', detail: 'On the machine.' },
  on_hold_file_issue: {
    label: 'On hold',
    tone: 'warn',
    detail: 'Waiting on the customer to fix a file.',
  },
  ready: { label: 'Ready', tone: 'success', detail: 'Waiting at the counter for pickup.' },
  collected: { label: 'Collected', tone: 'success', detail: 'Handed over. Payout accruing.' },
  settled: { label: 'Settled', tone: 'success', detail: 'Included in a payout.' },
  rejected: { label: 'Declined', tone: 'danger', detail: 'You declined this job.' },
  auto_cancelled: {
    label: 'Auto-cancelled',
    tone: 'danger',
    detail: 'Not accepted in time. This counts against your acceptance rate.',
  },
  cancelled_by_customer: {
    label: 'Cancelled',
    tone: 'neutral',
    detail: 'Customer cancelled before you accepted.',
  },
  cancelled_by_shop: { label: 'Cancelled', tone: 'danger', detail: 'You cancelled this order.' },
  expired: { label: 'Uncollected', tone: 'neutral', detail: 'Never picked up.' },
  refunded: { label: 'Refunded', tone: 'neutral', detail: 'Fully refunded to the customer.' },
  partially_refunded: {
    label: 'Part refunded',
    tone: 'warn',
    detail: 'Part of this order was refunded.',
  },
  closed_no_refund: { label: 'Closed', tone: 'neutral', detail: 'Closed with no refund.' },
  disputed: {
    label: 'Disputed',
    tone: 'warn',
    detail: 'Under review by Chaapo. Payout is held until it closes.',
    live: true,
  },
}

/**
 * The happy path, in order, for the customer tracking stepper.
 *
 * Deliberately not derived from the enum: the enum contains every state including the
 * fifteen ways an order can end, and a stepper that renders those as steps is a
 * stepper that tells someone their refund is step four of six.
 */
export const CUSTOMER_TRACK: readonly OrderState[] = [
  'placed',
  'accepted',
  'printing',
  'ready',
  'collected',
] as const

/** Where a state sits on the track, or `null` if it left the track. */
export function trackIndex(state: OrderState): number | null {
  const index = CUSTOMER_TRACK.indexOf(state)
  if (index >= 0) return index
  // `settled` is past the end of the visible track, not off it.
  if (state === 'settled') return CUSTOMER_TRACK.length - 1
  return null
}

/** States where the customer's money has moved but the job is not finished. */
export function isAwaitingShop(state: OrderState): boolean {
  return state === 'placed' || state === 'awaiting_quote'
}

/** Whether the pickup code should be shown. Only when there is something to collect. */
export function showsPickupCode(state: OrderState): boolean {
  return state === 'ready'
}

/**
 * Whether a customer may still cancel themselves.
 *
 * Mirrors the server rule (§F): once a shop has accepted, cancelling costs the shop
 * work already done, so it becomes a support request rather than a button.
 */
export function customerMayCancel(state: OrderState): boolean {
  return state === 'placed' || state === 'awaiting_quote' || state === 'payment_pending'
}

/** Whether this order can be rated. Rating an order nobody collected is noise. */
export function mayRate(state: OrderState): boolean {
  return state === 'collected' || state === 'settled'
}
