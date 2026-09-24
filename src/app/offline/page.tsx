/**
 * The offline page, precached by the service worker.
 *
 * Static on purpose — it has to render with no network and no data. It says the one
 * thing that actually matters to someone standing outside a shop: a placed order is
 * safe on the server, and the pickup code will be there when the connection is.
 */

import Link from 'next/link'
import type { Metadata } from 'next'
import { WifiOff } from 'lucide-react'

import { Card } from '@/components/ui/card'
import { Logo } from '@/components/shell/logo'

export const metadata: Metadata = { title: 'You are offline' }

export default function OfflinePage() {
  return (
    <div className="grid min-h-dvh place-items-center bg-paper px-4">
      <Card variant="clay" padding="lg" className="w-full max-w-sm text-center">
        <Logo size="md" className="mx-auto" />
        <div
          className="mx-auto mt-5 grid size-12 place-items-center rounded-full bg-paper-sunk text-ink-3 shadow-inset-well"
          aria-hidden
        >
          <WifiOff className="size-5" />
        </div>
        <h1 className="mt-4 font-display display-tight text-2xl text-ink">You are offline</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-3">
          Chaapo needs a connection to show shops and order status. Any order you already placed is
          safe on our servers, and your pickup code will be here when you are back online.
        </p>
        <Link
          href="/"
          className="mt-5 inline-flex text-sm font-medium text-chaap underline decoration-chaap-edge decoration-2 underline-offset-[3px] hover:decoration-chaap"
        >
          Try again
        </Link>
      </Card>
    </div>
  )
}
