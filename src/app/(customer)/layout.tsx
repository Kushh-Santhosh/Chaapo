/**
 * Customer PWA shell.
 *
 * Mobile-first, and the furniture is the minimum a phone product needs: one glass
 * sticky bar at the top, one tab bar at the bottom, and a content column that gets
 * out of the way. Everything else on a customer screen belongs to that screen.
 *
 * Two layout facts worth stating because the rest of the surface depends on them:
 *
 *   • The bottom tab bar is `fixed` and only exists below `md`. Content therefore
 *     carries `pb-24 md:pb-0`, and any screen with its own sticky action bar sits
 *     it *above* the tab bar (`bottom-[env(safe-area-inset-bottom)+4rem]`), never
 *     over it.
 *   • The content column is capped at `max-w-2xl` for reading and stretches to
 *     `max-w-6xl` only where a screen opts in. A print-shop list is a list, not a
 *     dashboard; giving it four columns on a laptop would make it a directory.
 */

import Link from 'next/link'

import { RegisterServiceWorker } from '@/components/pwa/register-service-worker'
import { CustomerTabBar, CustomerTopNav } from '@/components/shell/customer-tab-bar'
import { Logo } from '@/components/shell/logo'
import { brand } from '@/lib/brand'

export default function CustomerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-paper">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-paper-raised focus:px-3 focus:py-2 focus:text-sm focus:shadow-card"
      >
        Skip to content
      </a>

      <header className="glass sticky top-0 z-30 border-b border-rule">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <Link
            href="/"
            className="rounded-lg -m-1 p-1 transition-opacity duration-fast ease-out-soft hover:opacity-80"
            aria-label={`${brand.name} home`}
          >
            <Logo size="sm" />
          </Link>
          <div className="flex-1" />
          <CustomerTopNav />
        </div>
      </header>

      <main id="main" className="flex-1 pb-24 md:pb-10">
        {children}
      </main>

      <footer className="hidden border-t border-rule bg-paper-sunk md:block">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-6 text-xs text-ink-3">
          <p>
            {brand.legalEntity} · {brand.promise}
          </p>
          <nav aria-label="Legal" className="flex flex-wrap items-center gap-4">
            <Link href="/legal/terms" className="hover:text-ink">
              Terms
            </Link>
            <Link href="/legal/privacy" className="hover:text-ink">
              Privacy
            </Link>
            <Link href="/legal/refunds" className="hover:text-ink">
              Refunds
            </Link>
            <Link href="/support" className="hover:text-ink">
              Help
            </Link>
          </nav>
        </div>
      </footer>

      <CustomerTabBar />
      <RegisterServiceWorker />
    </div>
  )
}
