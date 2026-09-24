/**
 * A shop, as it appears in a list.
 *
 * The whole card is one link. Everything on it answers a question a customer asks
 * in the first two seconds — can it do my job, is it open, how far, how long, how
 * much — and nothing on it is decoration. The order those facts appear in is the
 * order they get asked in, not the order they are convenient to render.
 *
 * `from ₹1.50/page` is indicative and says what it applies to; the binding price
 * is the snapshot taken when the order is placed (PRD §11).
 */

import Link from 'next/link'
import { BadgeCheck, Clock, MapPin, Star } from 'lucide-react'

import { OpenStateBadge } from '@/components/discovery/open-state-badge'
import { ShopThumb } from '@/components/discovery/shop-thumb'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { FromPrice } from '@/components/ui/money'
import { cn } from '@/lib/cn'
import { describeAvailability } from '@/lib/time'
import {
  formatDistance,
  formatRating,
  formatTurnaround,
  type ShopSummary,
} from '@/server/domains/discovery/model'

/**
 * The capability chips, in the order they matter for the commonest jobs. Capped at
 * three plus an overflow count: a card listing nine capabilities is a spec sheet,
 * and nobody reads a spec sheet while walking.
 */
function capabilityLabels(shop: ShopSummary): string[] {
  const labels: string[] = []
  if (shop.capabilities.colour) labels.push('Colour')
  if (shop.capabilities.duplex) labels.push('Both sides')
  const sizes = shop.capabilities.paperSizes.filter((size) => size.toLowerCase() !== 'a4')
  if (sizes.length > 0) labels.push(sizes[0]!.toUpperCase())
  for (const finishing of shop.capabilities.finishings) {
    labels.push(finishing.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase()))
  }
  if (shop.capabilities.scanning) labels.push('Scanning')
  if (shop.capabilities.largeFormat) labels.push('Large format')
  return labels
}

export interface ShopCardProps {
  shop: ShopSummary
  /** The server's clock, passed in so every card on a page agrees. */
  now: Date
  className?: string
}

export function ShopCard({ shop, now, className }: ShopCardProps) {
  const availability = describeAvailability(shop.hours, shop.pausedUntil, shop.pauseReason, now)
  const rating = formatRating(shop.ratingAvgCenti, shop.ratingCount)
  const distance = formatDistance(shop.distanceMetres)
  const turnaround = formatTurnaround(shop.medianReadyMinutes ?? shop.defaultTurnaroundMinutes)
  const capabilities = capabilityLabels(shop)
  const shown = capabilities.slice(0, 3)
  const overflow = capabilities.length - shown.length

  return (
    <Card
      as="li"
      padding="none"
      className={cn('overflow-hidden', availability.tone === 'neutral' && 'opacity-[0.92]', className)}
    >
      <Link
        href={`/shops/${shop.slug}`}
        className={cn(
          'block p-4 transition-[background-color,box-shadow] duration-fast ease-out-soft',
          'hover:bg-paper-sunk/60 focus-visible:bg-paper-sunk/60',
          '[-webkit-tap-highlight-color:transparent]',
        )}
      >
        <div className="flex items-start gap-3.5">
          <ShopThumb name={shop.name} seed={shop.id} size="md" />

          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <h3 className="min-w-0 text-base leading-snug font-semibold text-ink">
                <span className="line-clamp-2">{shop.name}</span>
              </h3>
              {shop.verifiedAt ? (
                <span
                  className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-2xs font-semibold text-success"
                  title="Verified by Chaapo"
                >
                  <BadgeCheck className="size-3.5" aria-hidden />
                  Verified
                </span>
              ) : null}
            </div>

            <p className="mt-1 flex items-center gap-1 text-xs text-ink-3">
              <MapPin className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">
                {[shop.localityName, shop.cityName].filter(Boolean).join(', ') || 'Location on profile'}
              </span>
              {distance ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="shrink-0 font-mono tabular-nums">{distance}</span>
                </>
              ) : null}
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
              <OpenStateBadge
                hours={shop.hours}
                pausedUntil={shop.pausedUntil}
                pauseReason={shop.pauseReason}
                initial={availability}
              />
              <span className="inline-flex items-center gap-1 text-ink-2">
                <Clock className="size-3.5 text-ink-3" aria-hidden />
                {turnaround}
              </span>
              {rating ? (
                <span className="inline-flex items-center gap-1 text-ink-2">
                  <Star className="size-3.5 fill-warn text-warn" aria-hidden />
                  <span className="font-mono tabular-nums">{rating}</span>
                  <span className="text-ink-3">({shop.ratingCount})</span>
                </span>
              ) : (
                <span className="text-ink-3">New on Chaapo</span>
              )}
            </div>
          </div>
        </div>

        {shown.length > 0 || shop.fromPrice ? (
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-rule pt-3">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {shown.map((label) => (
                <Badge key={label} size="sm" tone="neutral">
                  {label}
                </Badge>
              ))}
              {overflow > 0 ? (
                <span className="text-2xs text-ink-3">+{overflow} more</span>
              ) : null}
            </div>
            {shop.fromPrice ? (
              <FromPrice
                value={shop.fromPrice.pricePaise}
                unit={shop.fromPrice.unit}
                note={shop.fromPrice.label}
                className="shrink-0"
              />
            ) : null}
          </div>
        ) : null}
      </Link>
    </Card>
  )
}
