'use client'

/**
 * The customer bottom tab bar.
 *
 * Bottom, not top, because this is a one-handed phone product used standing at a
 * counter or walking to one. Four destinations and no more: the fifth tab is where
 * navigation stops being glanceable, and the order flow itself is entered from a
 * shop rather than from a tab.
 *
 * Glass is used here deliberately — it is one of the two fixed-size layers in the
 * app (the other is the sticky action bar), so the blur cost does not scale with
 * page content.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { CircleUser, Map, Receipt, Store } from 'lucide-react'

import { cn } from '@/lib/cn'

interface Tab {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  /** Extra path prefixes that should light this tab up. */
  owns?: string[]
}

const TABS: Tab[] = [
  { href: '/', label: 'Shops', icon: Store, owns: ['/shops', '/order'] },
  { href: '/map', label: 'Map', icon: Map },
  { href: '/orders', label: 'Orders', icon: Receipt },
  { href: '/account', label: 'Account', icon: CircleUser },
]

function isActive(pathname: string, tab: Tab): boolean {
  if (tab.href === '/') {
    if (pathname === '/') return true
    return (tab.owns ?? []).some((prefix) => pathname.startsWith(prefix))
  }
  return pathname === tab.href || pathname.startsWith(`${tab.href}/`)
}

export function CustomerTabBar() {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Main"
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 md:hidden',
        'glass border-t border-rule',
        'pb-safe pt-1.5',
      )}
    >
      <ul className="mx-auto flex max-w-lg items-stretch justify-around px-2">
        {TABS.map((tab) => {
          const active = isActive(pathname, tab)
          const Icon = tab.icon
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group flex flex-col items-center gap-1 rounded-lg px-2 py-1.5',
                  'transition-colors duration-fast ease-out-soft',
                  '[-webkit-tap-highlight-color:transparent]',
                  active ? 'text-chaap' : 'text-ink-3 active:bg-paper-shade',
                )}
              >
                <span
                  className={cn(
                    'grid h-7 w-12 place-items-center rounded-full',
                    'transition-colors duration-fast ease-out-soft',
                    active && 'bg-chaap-tint',
                  )}
                >
                  <Icon className="size-5" />
                </span>
                <span className={cn('text-2xs leading-none', active && 'font-semibold')}>
                  {tab.label}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/**
 * The same destinations as a horizontal row, for the ≥md layout where the bottom
 * bar is hidden. Shares `TABS` so the two can never drift apart.
 */
export function CustomerTopNav() {
  const pathname = usePathname()

  return (
    <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
      {TABS.map((tab) => {
        const active = isActive(pathname, tab)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-lg px-3 py-2 text-sm font-medium',
              'transition-colors duration-fast ease-out-soft',
              active ? 'bg-chaap-tint text-chaap-deep' : 'text-ink-2 hover:bg-paper-sunk hover:text-ink',
            )}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
