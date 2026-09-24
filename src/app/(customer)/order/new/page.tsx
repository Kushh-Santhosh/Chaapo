/**
 * C-07 through C-11 — the customer order flow.
 *
 * The first screen of the order flow, and it starts before there is an account: a customer
 * who tapped "Start a print order" on a shop profile lands here with nothing but a slug in
 * the URL. Identity is minted by the first upload action, not by this render, because Next
 * forbids setting a cookie while rendering — which also means a visitor who only looks at
 * this page is never given one.
 *
 * The shop is looked up here, server-side, for two reasons that are not cosmetic. It proves
 * the shop is real, verified and live (`getShop` returns `null` otherwise, exactly as the
 * profile page relies on), and it supplies the caps the upload panel displays. The panel is
 * handed those numbers to *show*; the numbers that decide are re-read from the shop row
 * inside every action.
 *
 * The catalogue is loaded server-side so the configure panel has access to the shop's
 * actual capabilities without a round trip.
 *
 * `developmentStorage` is asked of the *storage* provider rather than of the file store: the
 * notice it drives is about where the bytes went, and the two seams are selected by different
 * environment variables.
 */

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { brand } from '@/lib/brand'
import { getShop } from '@/server/domains/discovery'
import {
  listDraft,
  totalsOf,
} from '@/server/domains/files'
import { findDevCatalogue } from '@/server/domains/pricing/fixtures'
import { getStorage } from '@/server/providers/storage'
import { readDraftOwnerId } from '@/server/http/draft-identity'

import { OrderFlow } from './order-flow'

type Search = { searchParams: Promise<Record<string, string | string[] | undefined>> }

export const metadata: Metadata = {
  title: `Your print order · ${brand.name}`,
  // Nothing here should ever be indexed: it is one customer's draft.
  robots: { index: false, follow: false },
}

function slugFrom(searchParams: Record<string, string | string[] | undefined>): string | null {
  const raw = searchParams.shop
  const slug = Array.isArray(raw) ? raw[0] : raw
  if (!slug || typeof slug !== 'string') return null
  // The slug goes into a database lookup, so it is bounded and shaped here rather than
  // trusted to be what the link that produced it wrote.
  return /^[a-z0-9-]{1,120}$/.test(slug) ? slug : null
}

export default async function OrderPage({ searchParams }: Search) {
  const slug = slugFrom(await searchParams)
  // No shop means there is no order to start. `notFound()` rather than a picker, because
  // arriving here without a shop is a broken link, not a choice the customer made.
  if (!slug) notFound()

  const shop = await getShop(slug)
  if (!shop) notFound()

  // Load the shop's catalogue so the configure panel can show actual options
  const catalogue = await findDevCatalogue(slug)
  if (!catalogue) notFound()

  /*
   * `readDraftOwnerId` and not `requireDraftOwnerId`: this is a render. A browser that has
   * never uploaded has no cookie and gets an empty draft, which is the truth. The cookie
   * appears the moment the first upload is attempted.
   */
  const ownerId = await readDraftOwnerId()
  const files = ownerId ? await listDraft(ownerId, shop.id) : []
  const initialDraft = { files, totals: totalsOf(files) }

  const storage = getStorage()

  return (
    <div className="pb-2">
      <OrderFlow
        shopSlug={shop.slug}
        shopName={shop.name}
        initialDraft={initialDraft}
        maxFiles={shop.maxFilesPerOrder}
        maxPages={shop.maxPagesPerOrder}
        developmentStorage={storage.isDevelopmentStore}
        catalogue={catalogue}
      />
    </div>
  )
}
