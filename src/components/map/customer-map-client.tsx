'use client'

import dynamic from 'next/dynamic'

import type { ShopSummary } from '@/server/domains/discovery'

const CustomerMap = dynamic(
  () => import('./customer-map').then((module) => module.CustomerMap),
  { ssr: false },
)

export function CustomerMapClient(props: { shops: ShopSummary[]; initialOrigin?: { latitude: number; longitude: number } | null }) {
  return <CustomerMap {...props} />
}
