import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { brand } from '@/lib/brand'
import { searchShops } from '@/server/domains/discovery'

import { CustomerMapClient } from '@/components/map/customer-map-client'

export const metadata: Metadata = {
  title: `${brand.name} — Map`,
  description: 'Find print shops near you on a map and open their profiles in one tap.',
  robots: { index: false, follow: false },
}

function parseOrigin(searchParams: Record<string, string | string[] | undefined>) {
  const read = (key: string) => {
    const raw = searchParams[key]
    const value = Array.isArray(raw) ? raw[0] : raw
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  const latitude = read('lat')
  const longitude = read('lng')
  if (latitude === undefined || longitude === undefined) return null
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  return { latitude, longitude }
}

export default async function CustomerMapPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const origin = parseOrigin(params)

  const result = await searchShops({
    ...(origin ? { origin } : {}),
    sort: 'nearest',
    limit: 12,
  })

  if (result.shops.length === 0 && !origin) {
    redirect('/')
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-5 sm:py-8">
      <CustomerMapClient shops={result.shops} initialOrigin={origin} />
    </div>
  )
}
