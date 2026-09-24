/**
 * 404.
 *
 * Also the page a customer reaches from a stale shop link or a suspended shop —
 * discovery returns `null` for both cases on purpose, so this wording must fit
 * either without hinting which happened.
 */

import Link from 'next/link'
import type { Metadata } from 'next'
import { Compass } from 'lucide-react'

import { Logo } from '@/components/shell/logo'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

export const metadata: Metadata = { title: 'Page not found' }

export default function NotFound() {
  return (
    <div className="grid min-h-dvh place-items-center bg-paper px-4 py-10">
      <Card variant="clay" padding="lg" className="w-full max-w-sm text-center">
        <Logo size="md" className="mx-auto" />
        <div
          className="mx-auto mt-5 grid size-12 place-items-center rounded-full bg-paper-sunk text-ink-3 shadow-inset-well"
          aria-hidden
        >
          <Compass className="size-5" />
        </div>
        <h1 className="mt-4 font-display display-tight text-2xl text-ink">
          This page is not here
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-3">
          The link may be old, or the shop may no longer be listed on Chaapo. Start from the shop
          list and you will get where you were going.
        </p>
        <Button asChild variant="primary" size="md" className="mt-5">
          <Link href="/">Find a print shop</Link>
        </Button>
      </Card>
    </div>
  )
}
