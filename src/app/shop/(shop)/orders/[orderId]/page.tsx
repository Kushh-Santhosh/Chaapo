import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, CheckCircle2, FileText, Printer, Truck } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Notice } from '@/components/ui/states'
import { Money } from '@/components/ui/money'
import { SHOP_STATE } from '@/lib/order-status'
import { getShopOrder } from '@/server/domains/orders/service'
import { requireShopSession } from '@/server/http/shop-identity'

import { transitionShopOrderAction } from '../actions'

export const metadata: Metadata = {
  title: 'Shop order',
  robots: { index: false, follow: false },
}

const ACTIONS = [
  { action: 'accept', label: 'Accept order', variant: 'primary' as const },
  { action: 'reject', label: 'Reject', variant: 'danger' as const },
  { action: 'start_printing', label: 'Start printing', variant: 'secondary' as const },
  { action: 'mark_ready', label: 'Mark ready', variant: 'secondary' as const },
  { action: 'mark_collected', label: 'Mark collected', variant: 'secondary' as const },
  { action: 'settle', label: 'Settle', variant: 'primary' as const },
]

export default async function ShopOrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>
  searchParams?: Promise<{ error?: string }>
}) {
  const { orderId } = await params
  const session = await requireShopSession()
  const order = await getShopOrder(session.shopId, orderId)
  if (!order) notFound()

  const error = (await searchParams)?.error
  const state = SHOP_STATE[order.state]

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link href="/shop/orders" className="inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden />
        Back to queue
      </Link>

      {error ? (
        <Notice tone="warn" title="This order cannot move yet">
          {error}
        </Notice>
      ) : null}

      <Card variant="clay" padding="md">
        <CardHeader
          eyebrow="Order"
          title={order.orderNumber}
          description={`Placed by ${order.customerUserId}`}
          action={<Badge tone={state.tone}>{state.label}</Badge>}
        />

        <div className="mt-4 space-y-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-ink-3">Customer</span>
            <span className="font-medium text-ink">{order.customerUserId}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-ink-3">Total</span>
            <Money value={order.totalPaise} size="xl" className="text-ink" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-ink-3">Placed</span>
            <span className="text-ink">
              {new Date(order.createdAt).toLocaleString('en-IN', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-rule pt-3">
            <span className="text-ink-3">Payment</span>
            <span className="font-medium capitalize text-ink">{order.paymentStatus ?? 'pending'}</span>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Files" eyebrow="Job details" />
        <div className="mt-4 space-y-3">
          {order.fileIds.map((fileId) => (
            <div key={fileId} className="flex items-center gap-3 rounded-lg bg-paper-sunk px-3 py-2.5">
              <div className="grid size-9 place-items-center rounded-md bg-paper-raised text-ink-3">
                <FileText className="size-4" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{fileId}</p>
                <p className="text-xs text-ink-3">Attached to this order</p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Queue actions" eyebrow="Workflow" />
        <div className="mt-4 flex flex-wrap gap-2">
          {ACTIONS.filter(({ action }) => {
            const permitted = {
              draft: ['accept'],
              awaiting_quote: ['accept', 'reject'],
              payment_pending: [],
              failed: [],
              placed: ['accept', 'reject'],
              accepted: ['start_printing'],
              printing: ['mark_ready'],
              on_hold_file_issue: ['accept', 'reject'],
              ready: ['mark_collected'],
              collected: ['settle'],
              settled: [],
              rejected: [],
              auto_cancelled: [],
              cancelled_by_customer: [],
              cancelled_by_shop: [],
              expired: [],
              refunded: [],
              partially_refunded: [],
              closed_no_refund: [],
              disputed: [],
            }[order.state] ?? []
            return (permitted as readonly string[]).includes(action)
          }).map(({ action, label, variant }) => (
            <form key={action} action={transitionShopOrderAction} className="contents">
              <input type="hidden" name="orderId" value={order.id} />
              <input type="hidden" name="action" value={action} />
              <Button type="submit" variant={variant} size="md">
                {action === 'accept' ? <CheckCircle2 className="size-4" aria-hidden /> : null}
                {action === 'start_printing' ? <Printer className="size-4" aria-hidden /> : null}
                {action === 'mark_collected' ? <Truck className="size-4" aria-hidden /> : null}
                {label}
              </Button>
            </form>
          ))}
        </div>
      </Card>
    </div>
  )
}
