'use server'

import { redirect } from 'next/navigation'

import { transitionOrder, type OrderAction } from '@/server/domains/orders/service'
import { requireShopSession } from '@/server/http/shop-identity'

const VALID_ACTIONS = ['accept', 'reject', 'start_printing', 'mark_ready', 'mark_collected', 'settle'] as const

export async function transitionShopOrderAction(formData: FormData): Promise<void> {
  const session = await requireShopSession()
  const orderId = String(formData.get('orderId') ?? '')
  const action = String(formData.get('action') ?? '')

  if (!orderId || !(VALID_ACTIONS as readonly string[]).includes(action)) {
    redirect(`/shop/orders/${orderId || ''}`)
  }

  const result = await transitionOrder({ orderId, shopId: session.shopId, action: action as OrderAction })
  if (!result.ok) {
    redirect(`/shop/orders/${orderId}?error=${encodeURIComponent(result.error.message)}`)
  }

  redirect(`/shop/orders/${orderId}`)
}
