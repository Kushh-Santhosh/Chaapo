/**
 * Customer order history.
 *
 * This is not a placeholder — it is the customer-facing archive of orders they actually
 * placed through the current browser. The page resolves identity from a signed-in customer
 * session if present, falling back to the draft owner for a device that is still browsing
 * without an account.
 */

import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight, ReceiptText } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/states'
import { Money } from '@/components/ui/money'
import { CUSTOMER_STATE } from '@/lib/order-status'
import { listCustomerOrders } from '@/server/domains/orders/service'
import { readCustomerUserId } from '@/server/http/customer-identity'

export const metadata: Metadata = {
  title: 'My orders',
  robots: { index: false, follow: false },
}

export default async function CustomerOrdersPage() {
  const customerUserId = await readCustomerUserId()

  if (!customerUserId) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 sm:py-10">
        <EmptyState
          icon={<ReceiptText className="size-6" aria-hidden />}
          title="No orders yet"
          description="Your print history appears here once you place one. There is nothing to hide — this device is simply not tied to a saved customer yet."
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

  if (orders.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 sm:py-10">
        <EmptyState
          icon={<ReceiptText className="size-6" aria-hidden />}
          title="No orders yet"
          description="Your order history will appear here as soon as you place a print job."
          action={
            <Button asChild variant="primary" size="md">
              <Link href="/">Shop nearby</Link>
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-5 sm:py-8">
      <header className="mb-5">
        <p className="eyebrow">Your jobs</p>
        <h1 className="mt-1 font-display display-tight text-3xl text-ink">My orders</h1>
      </header>

      <ul className="space-y-3">
        {orders.map((order) => {
          const state = CUSTOMER_STATE[order.state]

          return (
            <li key={order.id}>
              <Card interactive as="article" className="overflow-hidden">
                <Link href={`/orders/${order.id}`} className="block p-0">
                  <div className="flex items-start justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-mono text-xs text-ink-3">{order.orderNumber}</p>
                        <Badge tone={state.tone} size="sm">{state.label}</Badge>
                      </div>
                      <p className="mt-2 text-sm font-medium text-ink">Shop {order.shopId}</p>
                      <p className="mt-1 text-xs text-ink-3">
                        {new Date(order.createdAt).toLocaleDateString('en-IN', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </p>
                    </div>

                    <div className="shrink-0 text-right">
                      <p className="text-xs text-ink-3">Total</p>
                      <Money value={order.totalPaise} size="lg" className="mt-1 text-ink" />
                    </div>
                  </div>

                  <div className="flex items-center justify-between border-t border-rule px-4 py-3 text-sm text-ink-3">
                    <span>{order.fileIds.length} file{order.fileIds.length === 1 ? '' : 's'}</span>
                    <span className="inline-flex items-center gap-1 font-medium text-chaap">
                      View order <ArrowRight className="size-4" aria-hidden />
                    </span>
                  </div>
                </Link>
              </Card>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
