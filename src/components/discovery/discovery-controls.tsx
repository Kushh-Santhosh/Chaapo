'use client'

/**
 * Discovery controls — search, sort, filters, location.
 *
 * All state lives in the URL. That is the whole design: a filtered search is
 * shareable, the back button works, and the server component above re-runs the
 * *same* query code for a link someone pasted as it does for a tap. There is no
 * client-side copy of the result list to keep in sync.
 *
 * Location is asked for on a tap, never on load — a permission prompt fired at a
 * first-time visitor before they know what the app is gets denied, and a denial is
 * sticky. Coordinates are rounded to about 10 m before they go in the URL: enough
 * for "450 m away", not a precise home address in a link someone shares.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Check, Crosshair, Loader2, Search, SlidersHorizontal, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/field'
import { Notice } from '@/components/ui/states'
import { cn } from '@/lib/cn'

/**
 * Boolean capability filters, in the order they get used.
 *
 * `spiral` is named for the specific finishing rather than a vague "Binding",
 * because that is what the filter actually does — `DiscoveryFilters.finishing`
 * matches one finishing code, and a chip that promises "binding" while matching
 * only spiral would quietly hide the shops that hard-bind.
 */
const TOGGLES = [
  { key: 'open', label: 'Open now' },
  { key: 'colour', label: 'Colour' },
  { key: 'duplex', label: 'Both sides' },
  { key: 'spiral', label: 'Spiral binding' },
  { key: 'scan', label: 'Scanning' },
  { key: 'large', label: 'Large format' },
] as const

const SORTS = [
  { key: 'nearest', label: 'Nearest' },
  { key: 'fastest', label: 'Fastest' },
  { key: 'cheapest', label: 'Cheapest' },
  { key: 'rating', label: 'Top rated' },
] as const

export interface DiscoveryControlsProps {
  /** True when the current URL already carries coordinates. */
  hasLocation: boolean
}

export function DiscoveryControls({ hasLocation }: DiscoveryControlsProps) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()

  const [query, setQuery] = useState(params.get('q') ?? '')
  const [locating, setLocating] = useState(false)
  const [locationError, setLocationError] = useState<string | null>(null)
  const debounce = useRef<number | undefined>(undefined)

  // An external navigation (back button, a pasted link) must win over local state.
  const urlQuery = params.get('q') ?? ''
  useEffect(() => {
    setQuery(urlQuery)
  }, [urlQuery])

  const push = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(params.toString())
      mutate(next)
      // Any change to the query invalidates the page cursor.
      next.delete('cursor')
      const search = next.toString()
      startTransition(() => {
        router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false })
      })
    },
    [params, pathname, router],
  )

  useEffect(() => {
    if (query === urlQuery) return
    window.clearTimeout(debounce.current)
    debounce.current = window.setTimeout(() => {
      push((next) => {
        const trimmed = query.trim()
        if (trimmed) next.set('q', trimmed)
        else next.delete('q')
      })
    }, 300)
    return () => window.clearTimeout(debounce.current)
  }, [query, urlQuery, push])

  const activeSort = params.get('sort') ?? 'nearest'
  const activeToggles = useMemo(
    () => new Set(TOGGLES.filter((toggle) => params.get(toggle.key) === '1').map((t) => t.key)),
    [params],
  )
  const filterCount = activeToggles.size + (params.get('q') ? 1 : 0)

  const locate = () => {
    if (!('geolocation' in navigator)) {
      setLocationError('This browser cannot share your location. Search by area name instead.')
      return
    }
    setLocating(true)
    setLocationError(null)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false)
        push((next) => {
          next.set('lat', position.coords.latitude.toFixed(4))
          next.set('lng', position.coords.longitude.toFixed(4))
          if (!next.has('sort')) next.set('sort', 'nearest')
        })
      },
      (error) => {
        setLocating(false)
        setLocationError(
          error.code === error.PERMISSION_DENIED
            ? 'Location is blocked for this site. Allow it in your browser settings, or search by area name.'
            : 'Could not get your location just now. Search by area name instead.',
        )
      },
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 120_000 },
    )
  }

  const clearLocation = () => {
    push((next) => {
      next.delete('lat')
      next.delete('lng')
      next.delete('radius')
    })
  }

  return (
    <div className="space-y-3" data-pending={pending ? '' : undefined}>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            type="search"
            inputMode="search"
            enterKeyHint="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Shop or area — “Kothrud”, “FC Road”"
            aria-label="Search shops and areas"
            prefix={<Search className="size-4" aria-hidden />}
            suffix={
              query ? (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                  className="grid size-5 place-items-center rounded-full text-ink-3 hover:bg-paper-shade hover:text-ink"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              ) : undefined
            }
          />
        </div>
        <Button
          variant={hasLocation ? 'secondary' : 'primary'}
          size="md"
          onClick={hasLocation ? clearLocation : locate}
          loading={locating}
          className="shrink-0"
        >
          {hasLocation ? (
            <>
              <Check className="size-4" aria-hidden />
              <span className="hidden sm:inline">Near me</span>
            </>
          ) : (
            <>
              <Crosshair className="size-4" aria-hidden />
              <span className="hidden sm:inline">Near me</span>
            </>
          )}
        </Button>
      </div>

      {locationError ? (
        <Notice tone="warn" className="text-xs">
          {locationError}
        </Notice>
      ) : null}

      {/* One scrolling row rather than a filter sheet: six chips fit, and a sheet
          for six options is two taps where one would do. */}
      <div className="no-scrollbar -mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-0.5">
        <span className="inline-flex shrink-0 items-center gap-1.5 text-2xs text-ink-3">
          <SlidersHorizontal className="size-3.5" aria-hidden />
          {filterCount > 0 ? `${filterCount} active` : 'Filter'}
        </span>
        {TOGGLES.map((toggle) => {
          const active = activeToggles.has(toggle.key)
          return (
            <button
              key={toggle.key}
              type="button"
              aria-pressed={active}
              onClick={() =>
                push((next) => {
                  if (active) next.delete(toggle.key)
                  else next.set(toggle.key, '1')
                })
              }
              className={cn(
                'shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium',
                'transition-[background-color,border-color,color,box-shadow] duration-fast ease-out-soft',
                '[-webkit-tap-highlight-color:transparent]',
                active
                  ? 'border-chaap-edge bg-chaap-tint text-chaap-deep shadow-hair'
                  : 'border-rule bg-paper-raised text-ink-2 hover:border-rule-strong hover:text-ink',
              )}
            >
              {toggle.label}
            </button>
          )
        })}
      </div>

      <div className="flex items-center justify-between gap-3">
        <div
          role="radiogroup"
          aria-label="Sort shops"
          className="flex items-center gap-0.5 rounded-lg bg-paper-sunk p-0.5 shadow-inset-well"
        >
          {SORTS.map((sort) => {
            const active = activeSort === sort.key
            return (
              <button
                key={sort.key}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() =>
                  push((next) => {
                    if (sort.key === 'nearest') next.delete('sort')
                    else next.set('sort', sort.key)
                  })
                }
                className={cn(
                  'rounded-md px-2.5 py-1.5 text-xs font-medium whitespace-nowrap',
                  'transition-[background-color,color,box-shadow] duration-fast ease-out-soft',
                  active
                    ? 'bg-paper-raised text-ink shadow-hair'
                    : 'text-ink-3 hover:text-ink',
                )}
              >
                {sort.label}
              </button>
            )
          })}
        </div>

        {pending ? (
          <span className="inline-flex items-center gap-1.5 text-2xs text-ink-3" role="status">
            <Loader2 className="size-3.5 animate-spin-slow" aria-hidden />
            Updating
          </span>
        ) : null}
      </div>
    </div>
  )
}
