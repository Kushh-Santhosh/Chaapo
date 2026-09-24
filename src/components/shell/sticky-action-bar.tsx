/**
 * The sticky action bar — the "do the thing" strip at the bottom of a customer screen.
 *
 * It exists because the primary action on a phone screen must be reachable with a
 * thumb without scrolling to the end of a price list. Two facts about the customer
 * layout are baked in here rather than repeated at every call site:
 *
 *   1. The tab bar is `fixed` and `md:hidden`, so on mobile this must sit *above* it.
 *      The offset is the tab bar's own measured height (icon well + label + its
 *      padding ≈ 4.75rem) plus the safe-area inset it also reserves; on desktop the
 *      bar is gone and this drops to `bottom-0`.
 *   2. It is `glass` because it floats over scrolling content — one of the few places
 *      the backdrop filter earns its cost, since the strip does not itself scroll.
 *
 * `secondary` is on the left and deliberately quieter: the left slot is usually a fact
 * (a total, a page count) rather than a second button, and a screen with two equally
 * loud actions has not decided what it is for.
 */

import { cn } from '@/lib/cn'

export function StickyActionBar({
  secondary,
  children,
  className,
}: {
  /** Left slot — usually a price, a count, or a one-line status. */
  secondary?: React.ReactNode
  /** The primary action. */
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'fixed inset-x-0 z-30',
        'bottom-[calc(4.75rem+env(safe-area-inset-bottom,0px))] md:bottom-0',
        'glass border-t border-rule',
        className,
      )}
    >
      <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3 md:pb-4">
        {secondary ? <div className="min-w-0 flex-1">{secondary}</div> : null}
        <div className={cn('shrink-0', !secondary && 'flex-1')}>{children}</div>
      </div>
    </div>
  )
}

/**
 * Spacer to put at the end of a screen that uses the bar, so the last card is not
 * hidden under it. A spacer rather than padding on `<main>` because only some screens
 * have a bar, and a layout that pads for one it might not have leaves dead space.
 */
export function StickyActionBarSpacer() {
  return <div className="h-20" aria-hidden />
}
