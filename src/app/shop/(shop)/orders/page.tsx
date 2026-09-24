import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight, ReceiptText } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/states'
import { Money } from '@/components/ui/money'
import { SHOP_STATE } from '@/lib/order-status'
import { listShopOrders } from '@/server/domains/orders/service'
import { requireShopSession } from '@/server/http/shop-identity'

export const metadata: Metadata = {
  title: 'Shop queue',
  robots: { index: false, follow: false },
}

export default async function ShopOrdersPage() {
  const session = await requireShopSession()
  const orders = await listShopOrders(session.shopId)

  if (orders.length === 0) {
    return (
      <div className="mx-auto max-w-2xl">
        <EmptyState
          icon={<ReceiptText className="size-6" aria-hidden />}
          title="No orders yet"
          description="When a customer places a job for this shop, it will appear here ready for the next action."
          action={
            <Button asChild variant="primary" size="md">
              <Link href="/shop/login">Switch shop</Link>
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Orders</p>
          <h1 className="mt-1 font-display display-tight text-3xl text-ink">{session.label} queue</h1>
        </div>
        <Badge tone="info" size="md">{orders.length} live</Badge>
      </header>

      <ul className="space-y-3">
        {orders.map((order) => {
          const state = SHOP_STATE[order.state]

          return (
            <li key={order.id}>
              <Card interactive as="article" className="overflow-hidden">
                <Link href={`/shop/orders/${order.id}`} className="block p-0">
                  <div className="flex items-start justify-between gap-4 p-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-mono text-xs text-ink-3">{order.orderNumber}</p>
                        <Badge tone={state.tone} size="sm">{state.label}</Badge>
                      </div>
                      <p className="mt-2 text-sm font-medium text-ink">Customer {order.customerUserId}</p>
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
                      Open order <ArrowRight className="size-4" aria-hidden />
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
