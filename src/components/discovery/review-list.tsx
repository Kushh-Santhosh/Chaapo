/**
 * Recent ratings on a shop profile.
 *
 * Stars, an author label and a date. No review text and no shop reply: both are V1
 * (PRD C-06, C-18, FR-803/804), because published prose needs moderation and a right of
 * reply before it goes in front of anyone. `ShopReview` does not carry those fields, so
 * this component could not render them even if it wanted to.
 *
 * Author labels arrive already reduced to a first name plus an initial — the read model
 * never carries a full name or a number, so there is nothing to redact here.
 */

import { Star } from 'lucide-react'

import { cn } from '@/lib/cn'
import { formatIstDate } from '@/lib/time'
import type { ShopReview } from '@/server/domains/discovery'

function Stars({ stars }: { stars: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${stars} out of 5`}>
      {[1, 2, 3, 4, 5].map((position) => (
        <Star
          key={position}
          className={cn(
            'size-3.5',
            position <= stars ? 'fill-warn text-warn' : 'fill-transparent text-rule-strong',
          )}
          aria-hidden
        />
      ))}
    </span>
  )
}

export function ReviewList({ reviews, className }: { reviews: ShopReview[]; className?: string }) {
  if (reviews.length === 0) {
    return (
      <p className={cn('text-sm leading-relaxed text-ink-3', className)}>
        No ratings yet. Only customers who actually collected an order here can leave one, so this
        fills up slowly and honestly.
      </p>
    )
  }

  return (
    <ul className={cn('divide-y divide-rule', className)}>
      {reviews.map((review) => (
        <li
          key={review.id}
          className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
        >
          <div className="flex items-center gap-2">
            <Stars stars={review.stars} />
            <span className="text-sm font-medium text-ink">{review.authorLabel}</span>
          </div>
          <time
            dateTime={review.createdAt}
            className="shrink-0 font-mono text-2xs tabular-nums text-ink-4"
          >
            {formatIstDate(new Date(review.createdAt))}
          </time>
        </li>
      ))}
    </ul>
  )
}
