/**
 * Shop profile — C-06. The destination of every card on discovery.
 *
 * `getShop` returns `null` for a shop that does not exist, is unverified, is not live,
 * or is suspended, and this page renders `notFound()` for all of them identically.
 * That is deliberate: a distinct "this shop is suspended" page would leak a moderation
 * decision to anyone holding an old link.
 *
 * The order of the page is the order the questions get asked at a counter: can they do
 * my job, are they open, where are they, what does it cost, do people trust them, what
 * are the rules. The CTA is pinned so the answer to "so can I send it?" is never more
 * than a thumb away.
 */

import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  BadgeCheck,
  ChevronLeft,
  Clock,
  IndianRupee,
  MapPin,
  Navigation,
  Phone,
  Printer,
  Star,
} from 'lucide-react'

import { OpenStateBadge } from '@/components/discovery/open-state-badge'
import { PriceList } from '@/components/discovery/price-list'
import { ReviewList } from '@/components/discovery/review-list'
import { ShopHours } from '@/components/discovery/shop-hours'
import { ShopThumb } from '@/components/discovery/shop-thumb'
import { StickyActionBar, StickyActionBarSpacer } from '@/components/shell/sticky-action-bar'
import { describeAvailability } from '@/lib/time'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Money } from '@/components/ui/money'
import { Notice } from '@/components/ui/states'
import { brand } from '@/lib/brand'
import { formatIstDate, formatIstDateTime, nowUtc } from '@/lib/time'
import {
  formatDistance,
  formatRating,
  formatTurnaround,
  getShop,
  type ShopCapabilitySummary,
  type ShopDetail,
} from '@/server/domains/discovery'

type Params = { params: Promise<{ id: string }> }

/** Coordinates are only ever read from the URL, so a shared profile link keeps distance. */
function originFrom(searchParams: Record<string, string | string[] | undefined> | undefined) {
  if (!searchParams) return undefined
  const read = (key: string) => {
    const value = searchParams[key]
    const raw = Array.isArray(value) ? value[0] : value
    if (!raw) return undefined
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const latitude = read('lat')
  const longitude = read('lng')
  if (latitude === undefined || longitude === undefined) return undefined
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined
  return { latitude, longitude }
}

async function load(id: string): Promise<ShopDetail | null> {
  // A missing database throws out of here on purpose: the error boundary says "could
  // not load", which is true, where `notFound()` would claim the shop does not exist.
  return getShop(id)
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params
  let shop: ShopDetail | null = null
  try {
    shop = await load(id)
  } catch {
    shop = null
  }
  if (!shop) return { title: 'Shop not found' }

  const where = [shop.localityName, shop.cityName].filter(Boolean).join(', ')
  return {
    title: `${shop.name}${where ? ` — ${where}` : ''}`,
    description:
      shop.tagline ??
      `Send print jobs to ${shop.name}${where ? ` in ${where}` : ''} and collect them without queuing. ${brand.name}.`,
    // Shop profiles are worth indexing; nothing on this page is personal.
    robots: { index: true, follow: true },
  }
}

const CAPABILITY_ROWS: { label: string; read: (c: ShopCapabilitySummary) => boolean }[] = [
  { label: 'Black & white', read: (c) => c.bw },
  { label: 'Colour', read: (c) => c.colour },
  { label: 'Both sides', read: (c) => c.duplex },
  { label: 'Card stock', read: (c) => c.cardStock },
  { label: 'Photo paper', read: (c) => c.photoPaper },
  { label: 'Large format', read: (c) => c.largeFormat },
  { label: 'Scanning', read: (c) => c.scanning },
]

/** 'soft_bind' → 'Soft bind'. The codes are stable; the labels are for people. */
function humanise(code: string): string {
  const spaced = code.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export default async function ShopProfilePage({
  params,
  searchParams,
}: Params & { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, rawSearch] = await Promise.all([params, searchParams])
  const origin = originFrom(rawSearch)
  const shop = origin ? await getShop(id, origin) : await load(id)
  if (!shop) notFound()

  const now = nowUtc()
  const availability = describeAvailability(shop.hours, shop.pausedUntil, shop.pauseReason, now)
  const rating = formatRating(shop.ratingAvgCenti, shop.ratingCount)
  const distance = formatDistance(shop.distanceMetres)
  const turnaround = formatTurnaround(shop.medianReadyMinutes ?? shop.defaultTurnaroundMinutes)
  const observed = shop.medianReadyMinutes !== null

  const address = [shop.addressLine1, shop.addressLine2, shop.landmark, shop.pincode]
    .filter((line): line is string => Boolean(line && line.trim()))
  const mapsHref =
    shop.latitude !== null && shop.longitude !== null
      ? `https://www.google.com/maps/search/?api=1&query=${shop.latitude},${shop.longitude}`
      : null

  const finishings = shop.capabilities.finishings.map(humanise)
  const paperSizes = shop.capabilities.paperSizes
  const upcomingClosures = shop.closures.filter(
    (closure) => new Date(closure.endsAt).getTime() > now.getTime(),
  )
  const paused = shop.pausedUntil !== null && new Date(shop.pausedUntil).getTime() > now.getTime()

  return (
    <div className="mx-auto max-w-2xl px-4 py-5 sm:py-8">
      {/*
        A real link back to discovery rather than a history-based back button: this page
        is shareable and is often the first thing someone opens, where `history.back()`
        would leave the app entirely.
      */}
      <Link
        href="/"
        className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-ink-3 hover:text-ink"
      >
        <ChevronLeft className="size-3.5" aria-hidden />
        All shops
      </Link>

      {/* ── Identity ─────────────────────────────────────────────────────── */}
      <header className="flex items-start gap-3.5">
        <ShopThumb name={shop.name} seed={shop.id} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="font-display display-tight text-2xl text-ink text-balance sm:text-3xl">
            {shop.name}
          </h1>
          {shop.tagline ? (
            <p className="mt-1 text-sm leading-relaxed text-ink-3">{shop.tagline}</p>
          ) : null}
          {shop.verifiedAt ? (
            <p className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-success">
              <BadgeCheck className="size-3.5" aria-hidden />
              Verified in person on {formatIstDate(new Date(shop.verifiedAt))}
            </p>
          ) : null}
        </div>
      </header>

      {/* ── The four facts a decision is made on ─────────────────────────── */}
      <Card variant="clay" padding="md" className="mt-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3.5 sm:grid-cols-4">
          <div>
            <dt className="eyebrow">Status</dt>
            <dd className="mt-1">
              <OpenStateBadge
                hours={shop.hours}
                pausedUntil={shop.pausedUntil}
                pauseReason={shop.pauseReason}
                initial={availability}
              />
            </dd>
          </div>
          <div>
            <dt className="eyebrow">Usually ready</dt>
            <dd className="mt-1 flex items-baseline gap-1.5 text-sm font-medium text-ink">
              <Clock className="size-3.5 shrink-0 text-ink-3" aria-hidden />
              {turnaround}
            </dd>
            <p className="mt-0.5 text-2xs text-ink-4">
              {observed ? 'Median of recent orders' : "Shop's own promise"}
            </p>
          </div>
          <div>
            <dt className="eyebrow">Rating</dt>
            <dd className="mt-1 text-sm font-medium text-ink">
              {rating ? (
                <span className="inline-flex items-baseline gap-1.5">
                  <Star className="size-3.5 shrink-0 fill-warn text-warn" aria-hidden />
                  {rating}
                  <span className="text-xs font-normal text-ink-3">({shop.ratingCount})</span>
                </span>
              ) : (
                <span className="text-ink-3">New on {brand.name}</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="eyebrow">{distance ? 'Distance' : 'Orders done'}</dt>
            <dd className="mt-1 font-mono text-sm tabular-nums text-ink">
              {distance ?? shop.ordersCompleted.toLocaleString('en-IN')}
            </dd>
          </div>
        </dl>
      </Card>

      {paused ? (
        <Notice tone="warn" className="mt-3 text-sm" title="This shop is not taking orders">
          {shop.pauseReason?.trim()
            ? shop.pauseReason
            : 'The shop has paused new orders for now.'}{' '}
          {shop.pausedUntil ? `Expected back by ${formatIstDateTime(new Date(shop.pausedUntil))}.` : ''}
        </Notice>
      ) : null}

      {upcomingClosures.length > 0 ? (
        <Notice tone="info" className="mt-3 text-sm" title="Planned closures">
          <ul className="space-y-0.5">
            {upcomingClosures.slice(0, 3).map((closure) => (
              <li key={closure.startsAt}>
                {formatIstDate(new Date(closure.startsAt))} – {formatIstDate(new Date(closure.endsAt))}
                {closure.reason ? ` · ${closure.reason}` : ''}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {/* ── About ────────────────────────────────────────────────────────── */}
      {shop.about ? (
        <Card className="mt-4">
          <CardHeader eyebrow="About" />
          <p className="mt-2 text-sm leading-relaxed text-ink-2 whitespace-pre-line">{shop.about}</p>
        </Card>
      ) : null}

      {/* ── What they can print ──────────────────────────────────────────── */}
      <Card className="mt-4">
        <CardHeader
          eyebrow="What they can do"
          title="Printing and finishing"
          action={
            <Badge tone="neutral" size="sm">
              {shop.capabilities.printerCount === 1
                ? '1 machine'
                : `${shop.capabilities.printerCount} machines`}
            </Badge>
          }
        />
        <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-3">
          {CAPABILITY_ROWS.map((row) => {
            const has = row.read(shop.capabilities)
            return (
              <li
                key={row.label}
                className={has ? 'flex items-center gap-1.5 text-ink' : 'flex items-center gap-1.5 text-ink-4'}
              >
                <Printer className="size-3.5 shrink-0" aria-hidden />
                <span className={has ? '' : 'line-through decoration-rule-strong'}>{row.label}</span>
              </li>
            )
          })}
        </ul>

        {paperSizes.length > 0 ? (
          <div className="mt-3.5">
            <p className="eyebrow">Paper sizes</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {paperSizes.map((size) => (
                <Badge key={size} tone="neutral" size="sm">
                  {size}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}

        {finishings.length > 0 ? (
          <div className="mt-3">
            <p className="eyebrow">Binding &amp; finishing</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {finishings.map((finishing) => (
                <Badge key={finishing} tone="chaap" size="sm">
                  {finishing}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      {/* ── Rate card ────────────────────────────────────────────────────── */}
      <Card className="mt-4">
        <CardHeader
          eyebrow="Rates"
          title="Price list"
          description="Published by the shop. Your total is itemised before you pay."
        />
        <PriceList groups={shop.priceList} className="mt-3.5" />
      </Card>

      {/* ── Hours ────────────────────────────────────────────────────────── */}
      <Card className="mt-4">
        <CardHeader eyebrow="Opening hours" title="This week" />
        <ShopHours hours={shop.hours} now={now} />
        <p className="mt-2 text-2xs text-ink-4">All times are India Standard Time.</p>
      </Card>

      {/* ── Where ────────────────────────────────────────────────────────── */}
      <Card className="mt-4">
        <CardHeader eyebrow="Where to collect" title="Address" />
        <div className="mt-2 flex items-start gap-2.5">
          <MapPin className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
          <address className="text-sm leading-relaxed text-ink-2 not-italic">
            {address.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
            {shop.localityName || shop.cityName ? (
              <span className="block">
                {[shop.localityName, shop.cityName].filter(Boolean).join(', ')}
              </span>
            ) : null}
          </address>
        </div>

        <div className="mt-3.5 flex flex-wrap gap-2">
          {mapsHref ? (
            <Button asChild variant="secondary" size="sm">
              <a href={mapsHref} target="_blank" rel="noreferrer noopener">
                <Navigation className="size-4" aria-hidden />
                Open in Maps
              </a>
            </Button>
          ) : null}
          {shop.contactPhoneMasked ? (
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-paper-sunk px-2.5 py-1.5 font-mono text-xs tabular-nums text-ink-2 shadow-inset-well">
              <Phone className="size-3.5 text-ink-3" aria-hidden />
              {shop.contactPhoneMasked}
            </span>
          ) : null}
        </div>
        {mapsHref ? (
          <p className="mt-2 text-2xs text-ink-4">
            The pin is accurate to about 100 m — enough to find the street, not the counter.
          </p>
        ) : null}
      </Card>

      {/* ── The rules ────────────────────────────────────────────────────── */}
      <Card className="mt-4">
        <CardHeader
          eyebrow="Before you order"
          title="This shop's rules"
          description="Set by the shop and applied at checkout, so nothing here is a surprise later."
        />
        <dl className="mt-3 divide-y divide-rule text-sm">
          <div className="flex items-baseline justify-between gap-4 py-2">
            <dt className="text-ink-2">Minimum order</dt>
            <dd className="text-ink">
              <Money value={shop.minOrderValuePaise} size="md" />
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 py-2">
            <dt className="text-ink-2">Time to accept your job</dt>
            <dd className="font-mono text-xs tabular-nums text-ink">
              {shop.acceptWindowMinutes} min
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 py-2">
            <dt className="text-ink-2">Held for collection after Ready</dt>
            <dd className="font-mono text-xs tabular-nums text-ink">{shop.pickupGraceHours} hrs</dd>
          </div>
          {shop.maxPagesPerOrder !== null ? (
            <div className="flex items-baseline justify-between gap-4 py-2">
              <dt className="text-ink-2">Pages per order</dt>
              <dd className="font-mono text-xs tabular-nums text-ink">
                up to {shop.maxPagesPerOrder.toLocaleString('en-IN')}
              </dd>
            </div>
          ) : null}
          {shop.maxFilesPerOrder !== null ? (
            <div className="flex items-baseline justify-between gap-4 py-2">
              <dt className="text-ink-2">Files per order</dt>
              <dd className="font-mono text-xs tabular-nums text-ink">
                up to {shop.maxFilesPerOrder}
              </dd>
            </div>
          ) : null}
        </dl>
        <p className="mt-2.5 text-2xs leading-relaxed text-ink-4">
          Your money is held by {brand.name} until you collect. If the shop cannot do the job it
          declines and you are refunded in full.
        </p>
      </Card>

      {/* ── Ratings ──────────────────────────────────────────────────────── */}
      <Card className="mt-4">
        <CardHeader
          eyebrow="Ratings"
          title={rating ? `${rating} out of 5` : 'Not rated yet'}
          description={
            shop.ratingCount > 0
              ? `${shop.ratingCount.toLocaleString('en-IN')} ${shop.ratingCount === 1 ? 'rating' : 'ratings'} from collected orders`
              : undefined
          }
        />
        <ReviewList reviews={shop.recentReviews} className="mt-3.5" />
      </Card>

      <p className="mt-4 text-center text-2xs text-ink-4">
        Something wrong with this listing?{' '}
        <Link href="/support" className="underline decoration-rule-strong underline-offset-2">
          Tell us
        </Link>
      </p>

      <StickyActionBarSpacer />

      <StickyActionBar
        secondary={
          shop.fromPrice ? (
            <p className="text-xs text-ink-3">
              from{' '}
              <Money value={shop.fromPrice.pricePaise} size="md" className="text-ink" />
              <span>/{shop.fromPrice.unit}</span>
              <span className="block text-2xs text-ink-4">{shop.fromPrice.label}</span>
            </p>
          ) : (
            <p className="text-xs text-ink-3">Itemised price before you pay</p>
          )
        }
      >
        {paused ? (
          <Button variant="secondary" size="md" disabled>
            Not taking orders
          </Button>
        ) : (
          <Button asChild variant="primary" size="md">
            <Link href={`/order/new?shop=${shop.slug}`}>
              <IndianRupee className="size-4" aria-hidden />
              Start a print order
            </Link>
          </Button>
        )}
      </StickyActionBar>
    </div>
  )
}
