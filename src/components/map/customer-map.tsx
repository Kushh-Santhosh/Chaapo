'use client'

import 'leaflet/dist/leaflet.css'

import L from 'leaflet'
import Link from 'next/link'
import { LocateFixed, MapPin, Route } from 'lucide-react'
import { type CSSProperties, useEffect, useMemo, useState } from 'react'
import { Circle, MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Notice } from '@/components/ui/states'
import { getMapTileProvider } from '@/lib/map/provider'
import type { ShopSummary } from '@/server/domains/discovery'

const makeMarkerIcon = (color: string) =>
  L.divIcon({
    className: 'shop-map-marker',
    html: `<span style="display:block;width:16px;height:16px;border-radius:9999px;border:2px solid rgba(255,255,255,0.9);background:${color};box-shadow:0 4px 12px rgba(18,19,26,0.18)"></span>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    popupAnchor: [0, -8],
  })

interface CustomerMapProps {
  shops: ShopSummary[]
  initialOrigin?: { latitude: number; longitude: number } | null
}

const DEFAULT_CENTER = { latitude: 18.5204, longitude: 73.8567 }

function MapBounds({ shops, userLocation }: { shops: ShopSummary[]; userLocation?: { latitude: number; longitude: number } | null }) {
  const map = useMap()

  useEffect(() => {
    const bounds = L.latLngBounds([])
    const points = shops.flatMap((shop) => {
      if (shop.latitude === null || shop.longitude === null) return []
      return [[shop.latitude, shop.longitude] as [number, number]]
    })

    if (points.length > 0) {
      points.forEach((point) => bounds.extend(point))
    }

    if (userLocation) {
      bounds.extend([userLocation.latitude, userLocation.longitude])
    }

    if (points.length === 0 && !userLocation) {
      map.setView([DEFAULT_CENTER.latitude, DEFAULT_CENTER.longitude], 12)
      return
    }

    if (points.length > 0 || userLocation) {
      const pad = points.length > 1 || userLocation ? 0.25 : 0.1
      map.fitBounds(bounds.pad(pad), { maxZoom: 13, animate: true })
    }
  }, [map, shops, userLocation])

  return null
}

export function CustomerMap({ shops, initialOrigin }: CustomerMapProps) {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const [locating, setLocating] = useState(false)
  const [locationError, setLocationError] = useState<string | null>(null)

  const userLocation = useMemo(() => {
    const rawLat = params.get('lat')
    const rawLng = params.get('lng')
    if (rawLat === null || rawLng === null) return null
    const lat = Number(rawLat)
    const lng = Number(rawLng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
    return { latitude: lat, longitude: lng }
  }, [params])

  const provider = getMapTileProvider('osm')
  const tileUrl = provider.tiles[0] ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
  const defaultCenter = initialOrigin ?? userLocation ?? DEFAULT_CENTER
  const mapStyle: CSSProperties = { height: 420, width: '100%' }

  const locate = () => {
    if (!('geolocation' in navigator)) {
      setLocationError('This browser cannot share your location, so the map will stay on the local area list.')
      return
    }

    setLocating(true)
    setLocationError(null)

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const next = new URLSearchParams(params.toString())
        next.set('lat', position.coords.latitude.toFixed(5))
        next.set('lng', position.coords.longitude.toFixed(5))
        router.replace(`${pathname}?${next.toString()}`, { scroll: false })
        setLocating(false)
      },
      (geolocationError) => {
        setLocating(false)
        setLocationError(
          geolocationError.code === 1
            ? 'Location access was blocked. You can keep browsing by area, or allow it in your browser settings.'
            : 'Location could not be read right now. Showing the nearest shops in the default area instead.',
        )
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 120_000 },
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="eyebrow">Map</p>
          <h1 className="mt-1.5 font-display display-tight text-display-sm text-ink">
            Shops around you
          </h1>
        </div>
        <Button variant={userLocation ? 'secondary' : 'primary'} onClick={locate} loading={locating} size="md">
          <LocateFixed className="size-4" aria-hidden />
          {userLocation ? 'Update my location' : 'Use my location'}
        </Button>
      </div>

      {locationError ? (
        <Notice tone="warn" className="text-xs">
          {locationError}
        </Notice>
      ) : null}

      <Card as="section" variant="plain" className="overflow-hidden border border-rule">
        <MapContainer
          center={[defaultCenter.latitude, defaultCenter.longitude]}
          zoom={12}
          scrollWheelZoom
          className="z-0"
          style={mapStyle}
        >
          <TileLayer
            url={tileUrl}
            attribution={provider.attribution}
            maxZoom={provider.maxZoom}
          />

          {userLocation ? (
            <Circle
              center={[userLocation.latitude, userLocation.longitude]}
              radius={400}
              pathOptions={{ color: '#d93f2b', fillColor: '#fdeeea', fillOpacity: 0.25 }}
            />
          ) : null}

          <MapBounds shops={shops} userLocation={userLocation} />

          {shops.map((shop) => {
            if (shop.latitude === null || shop.longitude === null) return null
            const isSelected = userLocation
              ? Math.abs(shop.latitude - userLocation.latitude) < 0.0005 &&
                Math.abs(shop.longitude - userLocation.longitude) < 0.0005
              : false

            return (
              <Marker
                key={shop.id}
                position={[shop.latitude, shop.longitude]}
                icon={makeMarkerIcon(isSelected ? '#d93f2b' : '#1f7a4d')}
              >
                <Popup>
                  <div className="space-y-2">
                    <div>
                      <p className="text-sm font-semibold text-ink">{shop.name}</p>
                      <p className="text-xs text-ink-3">{shop.localityName ?? shop.cityName}</p>
                    </div>
                    <Link href={`/shops/${shop.id}${userLocation ? `?lat=${userLocation.latitude}&lng=${userLocation.longitude}` : ''}`} className="inline-flex items-center gap-1 text-xs font-medium text-chaap hover:text-chaap-deep">
                      <MapPin className="size-3.5" aria-hidden />
                      View shop
                    </Link>
                  </div>
                </Popup>
              </Marker>
            )
          })}
        </MapContainer>
      </Card>

      <Card as="section" variant="plain" padding="md">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-ink">Nearby shops</h2>
          <span className="text-xs text-ink-3">{shops.length} results</span>
        </div>

        <ul className="mt-3 space-y-2">
          {shops.map((shop) => (
            <li key={shop.id}>
              <Link
                href={`/shops/${shop.id}${userLocation ? `?lat=${userLocation.latitude}&lng=${userLocation.longitude}` : ''}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-rule bg-paper-raised px-3 py-2.5 transition-colors hover:bg-paper-sunk"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{shop.name}</p>
                  <p className="mt-0.5 text-xs text-ink-3">
                    {shop.localityName ?? 'Local area'} · {shop.cityName ?? 'Pune'}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-ink-3">
                  <Route className="size-3.5" aria-hidden />
                  {shop.distanceMetres !== null ? `${Math.round(shop.distanceMetres / 100) / 10} km` : 'Map view'}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
