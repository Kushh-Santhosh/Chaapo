import Link from 'next/link'

import { Logo } from '@/components/shell/logo'
import { brand } from '@/lib/brand'
import { readShopSession } from '@/server/http/shop-identity'

export default async function ShopLayout({ children }: { children: React.ReactNode }) {
  const session = await readShopSession()

  return (
    <div className="min-h-dvh bg-paper">
      <header className="glass sticky top-0 z-30 border-b border-rule">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <Link href={session ? '/shop/orders' : '/shop/login'} className="rounded-lg -m-1 p-1">
            <Logo size="sm" />
          </Link>
          <div className="flex-1" />
          {session ? (
            <div className="flex items-center gap-3 text-sm text-ink-3">
              <span className="rounded-full bg-paper-sunk px-2 py-1 font-medium text-ink">
                {session.label}
              </span>
              <Link href="/shop/login" className="text-chaap hover:text-chaap-deep">
                Switch shop
              </Link>
            </div>
          ) : (
            <Link href="/shop/login" className="text-sm font-medium text-chaap">
              Shop login
            </Link>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:py-8">{children}</main>

      <footer className="border-t border-rule bg-paper-sunk">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-5 text-xs text-ink-3">
          <p>{brand.name} · Shop dashboard</p>
          <p>{brand.legalEntity}</p>
        </div>
      </footer>
    </div>
  )
}
