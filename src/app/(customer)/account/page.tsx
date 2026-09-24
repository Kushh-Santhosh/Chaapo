/**
 * Customer account surface.
 *
 * The account screen is intentionally lightweight in this branch: there is no full auth
 * flow yet, so the page reflects the current browser's order identity and points people
 * back to the real surfaces already in the app.
 */

import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight, CircleUser, FolderClock, ShieldCheck } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/states'
import { listCustomerOrders } from '@/server/domains/orders/service'
import { readCustomerUserId } from '@/server/http/customer-identity'

export const metadata: Metadata = {
  title: 'Account',
  robots: { index: false, follow: false },
}

export default async function CustomerAccountPage() {
  const customerUserId = await readCustomerUserId()

  if (!customerUserId) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 sm:py-10">
        <EmptyState
          icon={<CircleUser className="size-6" aria-hidden />}
          title="You are browsing as this device"
          description="Your account details will live here once a customer session exists. Until then, the app keeps your draft and order history attached to this browser."
          action={
            <Button asChild variant="primary" size="md">
              <Link href="/">Browse shops</Link>
            </Button>
          }
        />
      </div>
    )
  }

  const orders = await listCustomerOrders(customerUserId)
  const firstOrder = orders[0] ?? null

  return (
    <div className="mx-auto max-w-2xl px-4 py-5 sm:py-8">
      <div className="mb-5 flex items-center gap-3">
        <div className="grid size-12 place-items-center rounded-full bg-chaap-tint text-chaap-deep">
          <CircleUser className="size-5" aria-hidden />
        </div>
        <div>
          <p className="eyebrow">Customer</p>
          <h1 className="mt-1 font-display display-tight text-3xl text-ink">My account</h1>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader
            eyebrow="Orders"
            title={String(orders.length)}
            description="Placed through this customer"
          />
          <div className="mt-4">
            <Button asChild variant="secondary" size="sm" className="w-full justify-between">
              <Link href="/orders" className="inline-flex w-full items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2">
                  <FolderClock className="size-4" aria-hidden />
                  View history
                </span>
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            </Button>
          </div>
        </Card>

        <Card>
          <CardHeader
            eyebrow="Latest order"
            title={firstOrder ? firstOrder.orderNumber : 'No order yet'}
            description={
              firstOrder
                ? `Placed ${new Date(firstOrder.createdAt).toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' })}`
                : 'Your most recent job will appear here.'
            }
          />
          {firstOrder ? (
            <div className="mt-4">
              <Button asChild variant="link" size="sm">
                <Link href={`/orders/${firstOrder.id}`}>Open order</Link>
              </Button>
            </div>
          ) : null}
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader
          eyebrow="Safety"
          title="Identity stays on this device"
          description="The app reads your draft and orders from the current browser until a signed-in customer session is introduced."
          action={<ShieldCheck className="size-5 text-success" aria-hidden />}
        />
      </Card>
    </div>
  )
}
