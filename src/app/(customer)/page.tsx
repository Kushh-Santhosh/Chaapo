/**
 * Discovery home — the first screen of the product.
 *
 * A server component: the first page of results is rendered on the server so the
 * customer sees shops, not a spinner, on a mid-range Android over 4G (NFR-02).
 * Everything interactive is one client island (`DiscoveryControls`) that writes to
 * the URL, and this component re-runs on every URL change. There is no client-side
 * result cache to drift.
 *
 * Only verified, live, located, unsuspended shops can appear here, and that is not
 * enforced on this screen — it is enforced by the generated `shops.discoverable`
 * column that the discovery repository filters on. A screen cannot leak an
 * unverified shop by forgetting a clause.
 */

import Link from 'next/link'
import type { Metadata } from 'next'
import { AlertTriangle, MapPinOff, SearchX, Store } from 'lucide-react'

import { DiscoveryControls } from '@/components/discovery/discovery-controls'
import { ShopCard } from '@/components/discovery/shop-card'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState, Notice } from '@/components/ui/states'
import { brand } from '@/lib/brand'
import { nowUtc } from '@/lib/time'
import {
  MAX_RADIUS_METRES,
  MissingDatabaseError,
  searchShops,
  usingDevFixtures,
  type DiscoveryFilters,
  type DiscoveryQuery,
  type DiscoveryResult,
} from '@/server/domains/discovery'

export const metadata: Metadata = {
  title: `${brand.name} — ${brand.tagline}`,
  description: brand.description,
  // The one customer route that is worth indexing.
  robots: { index: true, follow: true },
}

/** Search params arrive as strings; everything below is a deliberate coercion. */
type RawParams = Record<string, string | string[] | undefined>

function one(params: RawParams, key: string): string | undefined {
  const value = params[key]
  return Array.isArray(value) ? value[0] : value
}

function flag(params: RawParams, key: string): true | undefined {
  return one(params, key) === '1' ? true : undefined
}

function coordinate(raw: string | undefined, bound: number): number | undefined {
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || Math.abs(value) > bound) return undefined
  return value
}

function buildQuery(params: RawParams): DiscoveryQuery {
  const latitude = coordinate(one(params, 'lat'), 90)
  const longitude = coordinate(one(params, 'lng'), 180)

  const filters: DiscoveryFilters = {}
  const q = one(params, 'q')?.trim()
  if (q) filters.q = q.slice(0, 80)
  if (flag(params, 'open')) filters.openNow = true
  if (flag(params, 'colour')) filters.colour = true
  if (flag(params, 'duplex')) filters.duplex = true
  if (flag(params, 'scan')) filters.scanning = true
  if (flag(params, 'large')) filters.largeFormat = true
  if (flag(params, 'spiral')) filters.finishing = 'spiral'

  const sort = one(params, 'sort')
  const query: DiscoveryQuery = {
    filters,
    sort:
      sort === 'fastest' || sort === 'cheapest' || sort === 'rating' || sort === 'nearest'
        ? sort
        : 'nearest',
  }

  if (latitude !== undefined && longitude !== undefined) {
    const radius = Number(one(params, 'radius'))
    query.origin = {
      latitude,
      longitude,
      ...(Number.isFinite(radius) && radius > 0
        ? { radiusMetres: Math.min(radius, MAX_RADIUS_METRES) }
        : {}),
    }
  }
  const cursor = one(params, 'cursor')
  if (cursor) query.cursor = cursor

  return query
}

/** The line above the list: what was searched, and how wide the net was thrown. */
function resultSummary(result: DiscoveryResult, located: boolean): string {
  const count = result.shops.length
  const shops = count === 1 ? '1 shop' : `${count} shops`
  if (!located) return `${shops} · showing all areas`
  const km = result.radiusMetresUsed ? Math.round(result.radiusMetresUsed / 100) / 10 : null
  return km ? `${shops} within ${km} km` : shops
}

export default async function DiscoveryHomePage({
  searchParams,
}: {
  searchParams: Promise<RawParams>
}) {
  const params = await searchParams
  const query = buildQuery(params)
  const located = query.origin !== undefined
  const now = nowUtc()

  let result: DiscoveryResult | null = null
  let failure: 'no-database' | 'unknown' | null = null
  try {
    result = await searchShops(query)
  } catch (error) {
    failure = error instanceof MissingDatabaseError ? 'no-database' : 'unknown'
  }

  const nextParams = new URLSearchParams(
    Object.entries(params).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, Array.isArray(value) ? (value[0] ?? '') : value] as [string, string]],
    ),
  )
  if (result?.nextCursor) nextParams.set('cursor', result.nextCursor)

  return (
    <div className="mx-auto max-w-2xl px-4 py-5 sm:py-8">
      <section className="mb-5">
        <p className="eyebrow">Print shops near you</p>
        <h1 className="mt-1.5 font-display display-tight text-display-sm text-ink">
          {brand.promise}{' '}
          <span className="text-chaap">{brand.promiseSecondary}</span>
        </h1>
      </section>

      <DiscoveryControls hasLocation={located} />

      {usingDevFixtures() ? (
        <Notice tone="info" className="mt-4 text-xs">
          Local sample data — six real Pune localities, no database connected. Prices and shops
          here are fixtures, not live listings.
        </Notice>
      ) : null}

      {failure === 'no-database' ? (
        <Card variant="outline" className="mt-6">
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
            <div className="text-sm">
              <p className="font-semibold text-ink">Discovery is not configured</p>
              <p className="mt-1 text-ink-3">
                This deployment has no database connection, and sample data is only served in
                development. Nothing is being hidden from you — there is genuinely nothing to read.
              </p>
            </div>
          </div>
        </Card>
      ) : null}

      {failure === 'unknown' ? (
        <Card variant="outline" className="mt-6">
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
            <div className="text-sm">
              <p className="font-semibold text-ink">Could not load shops</p>
              <p className="mt-1 text-ink-3">
                Something went wrong on our side. Reload the page — your search is in the address
                bar, so nothing is lost.
              </p>
            </div>
          </div>
        </Card>
      ) : null}

      {result ? (
        <>
          {result.widened ? (
            <Notice tone="warn" className="mt-4 text-xs">
              No shops within your usual radius, so we looked further out. The nearest results are
              below — check the distance before you set off.
            </Notice>
          ) : null}

          {result.shops.length > 0 ? (
            <>
              <div className="mt-5 mb-2.5 flex items-baseline justify-between gap-3">
                <p className="text-xs text-ink-3">{resultSummary(result, located)}</p>
                {!located ? (
                  <p className="text-2xs text-ink-4">Turn on “Near me” for distances</p>
                ) : null}
              </div>

              <ul className="space-y-2.5">
                {result.shops.map((shop) => (
                  <ShopCard key={shop.id} shop={shop} now={now} />
                ))}
              </ul>

              {result.nextCursor ? (
                <div className="mt-4 flex justify-center">
                  <Button asChild variant="secondary" size="md">
                    <Link href={`/?${nextParams.toString()}`} scroll>
                      More shops
                    </Link>
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <div className="mt-4">
              <Card padding="none">
                {Object.keys(query.filters ?? {}).length > 0 ? (
                  <EmptyState
                    icon={<SearchX className="size-6" />}
                    title="Nothing matches those filters"
                    description="Every shop nearby was ruled out by one of the chips above — colour, binding or “open now” are the usual culprits. Clear one and try again."
                    action={
                      <Button asChild variant="secondary" size="sm">
                        <Link href="/">Clear filters</Link>
                      </Button>
                    }
                  />
                ) : located ? (
                  <EmptyState
                    icon={<MapPinOff className="size-6" />}
                    title="No verified shops near you yet"
                    description="Chaapo only lists shops we have verified in person, and we have not reached your area yet. If you run a print shop here, we would like to hear from you."
                    action={
                      <Button asChild variant="secondary" size="sm">
                        <Link href="/shop/onboarding">List your shop</Link>
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    icon={<Store className="size-6" />}
                    title="No shops to show"
                    description="Search an area name, or turn on “Near me” so we can find the counters closest to you."
                  />
                )}
              </Card>
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}
