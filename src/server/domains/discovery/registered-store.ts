import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { newId } from '../../../lib/ids'
import type { ShopFixture } from './fixtures'

const STORE_PATH = resolve(process.cwd(), '.chaapo-registered-shops.json')

function read(): ShopFixture[] {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8')) as ShopFixture[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

let registered = read()

function persist(): void {
  writeFileSync(STORE_PATH, JSON.stringify(registered, null, 2), 'utf8')
}

export interface RegisterShopInput {
  ownerUserId: string
  name: string
  email: string
  phone: string
  addressLine1: string
  localityName: string
  cityName: string
  pincode: string
  latitude: number
  longitude: number
  about: string
  capabilities: ShopFixture['capabilities']
}

export function registerDevShop(input: RegisterShopInput): ShopFixture {
  const slug = input.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
  if (!slug || registered.some((shop) => shop.slug === slug)) {
    throw new Error('A shop with that name already exists.')
  }

  const shop: ShopFixture = {
    id: newId(),
    slug,
    name: input.name.trim(),
    tagline: 'Local printing, ready when you are',
    about: input.about.trim(),
    localityName: input.localityName.trim(),
    cityName: input.cityName.trim(),
    addressLine1: input.addressLine1.trim(),
    addressLine2: null,
    landmark: null,
    pincode: input.pincode.trim(),
    latitude: input.latitude,
    longitude: input.longitude,
    ratingAvgCenti: null,
    ratingCount: 0,
    ordersCompleted: 0,
    medianReadyMinutes: null,
    defaultTurnaroundMinutes: 30,
    acceptWindowMinutes: 10,
    pickupGraceHours: 48,
    minOrderValuePaise: '0',
    maxPagesPerOrder: 1000,
    maxFilesPerOrder: 20,
    contactPhoneMasked: input.phone.trim().replace(/.(?=.{4})/g, '•'),
    fromPrice: { pricePaise: '200', unit: 'page', label: 'B&W A4' },
    capabilities: input.capabilities,
    hours: [[{ open: 600, close: 1320 }], [{ open: 510, close: 1320 }], [{ open: 510, close: 1320 }], [{ open: 510, close: 1320 }], [{ open: 510, close: 1320 }], [{ open: 510, close: 1320 }], [{ open: 600, close: 1320 }]],
    pausedUntil: null,
    pauseReason: null,
    photoKey: null,
    photoKeys: [],
    verifiedAt: new Date().toISOString(),
    priceList: [{ heading: 'Printing', items: [{ code: 'print_bw_a4', label: 'Black & white', qualifier: 'A4 · one side', pricePaise: '200', unit: 'page', tiers: [] }] }],
    recentReviews: [],
    closures: [],
  }

  registered = [...registered, shop]
  persist()
  return shop
}

export function listRegisteredDevShops(): ShopFixture[] {
  return registered
}

export function findRegisteredDevShop(idOrSlug: string): ShopFixture | null {
  return registered.find((shop) => shop.id === idOrSlug || shop.slug === idOrSlug) ?? null
}

export function resetRegisteredDevShops(): void {
  registered = []
  persist()
}
