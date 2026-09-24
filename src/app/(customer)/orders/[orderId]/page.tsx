/**
 * Customer order detail.
 *
 * Shows the order the browser actually owns, including the printed order number and the
 * current state. This is intentionally a narrow page: the order itself exists in the dev
 * store, and the app is still missing the richer shop and account lifecycle screens.
 */

import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft, FileText, ReceiptText } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Money } from '@/components/ui/money'
import { CUSTOMER_STATE } from '@/lib/order-status'
import { getCustomerOrder } from '@/server/domains/orders/service'
import { readCustomerUserId } from '@/server/http/customer-identity'
import { cancelOrderPaymentAction, payOrderAction } from '@/app/(customer)/order/new/pricing-actions'

export const metadata: Metadata = {
  title: 'Order details',
  robots: { index: false, follow: false },
}

export default async function CustomerOrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>
  searchParams?: Promise<{ error?: string }>
}) {
  const { orderId } = await params
  const customerUserId = await readCustomerUserId()
  if (!customerUserId) notFound()

  const order = await getCustomerOrder(customerUserId, orderId)
  if (!order) notFound()

  const state = CUSTOMER_STATE[order.state]
  const error = (await searchParams)?.error

  async function payThisOrder(formData: FormData): Promise<void> {
    'use server'

    const result = await payOrderAction(formData)
    if (!result.ok) {
      redirect(`/orders/${orderId}?error=${encodeURIComponent(result.message)}`)
    }

    redirect(`/orders/${orderId}`)
  }

  async function cancelThisPayment(formData: FormData): Promise<void> {
    'use server'

    const result = await cancelOrderPaymentAction(formData)
    if (!result.ok) redirect(`/orders/${orderId}?error=${encodeURIComponent(result.message)}`)
    redirect(`/orders/${orderId}`)
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-5 sm:py-8">
      <Link
        href="/orders"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Back to orders
      </Link>

      <Card variant="clay" padding="md" className="mb-4">
        <CardHeader
          eyebrow="Order"
          title={order.orderNumber}
          action={<Badge tone={state.tone}>{state.label}</Badge>}
        />

        <div className="mt-4 space-y-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-ink-3">Shop</span>
            <span className="font-medium text-ink">{order.shopId}</span>
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

      {error ? <p className="mb-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null}

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

      {order.state === 'payment_pending' || order.state === 'failed' ? (
        <div className="mt-4 space-y-2">
          <form action={payThisOrder}>
            <input type="hidden" name="orderId" value={order.id} />
            <Button type="submit" variant="primary" size="md" className="w-full">
              {order.state === 'failed' ? 'Retry payment' : 'Pay now'}
            </Button>
          </form>
          <form action={cancelThisPayment}>
            <input type="hidden" name="orderId" value={order.id} />
            <Button type="submit" variant="secondary" size="md" className="w-full">
              Cancel payment
            </Button>
          </form>
        </div>
      ) : null}

      <div className="mt-4">
        <Button asChild variant="secondary" size="md" className="w-full">
          <Link href="/orders">
            <ReceiptText className="size-4" aria-hidden />
            All orders
          </Link>
        </Button>
      </div>
    </div>
  )
}
