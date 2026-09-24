import { describe, expect, it } from 'vitest'

import { mockPaymentProvider } from './mock'

describe('mock payment provider', () => {
  const order = {
    orderId: 'order-1',
    customerUserId: 'customer-1',
    shopId: 'shop-1',
    amountPaise: '1250',
  }

  it('starts and cancels a deterministic payment intent', async () => {
    const started = await mockPaymentProvider.startPayment(order)
    expect(started.providerPaymentId).toBe('mock-payment-order-1')
    expect(started.status).toBe('pending')

    const cancelled = await mockPaymentProvider.cancelPayment({
      orderId: order.orderId,
      customerUserId: order.customerUserId,
      providerPaymentId: started.providerPaymentId,
    })
    expect(cancelled).toEqual({ ok: true, providerPaymentId: started.providerPaymentId })
  })

  it('supports deterministic failure and success without external credentials', async () => {
    const failed = await mockPaymentProvider.completePayment({
      orderId: order.orderId,
      customerUserId: order.customerUserId,
      providerPaymentId: 'mock-payment-order-1-fail',
      amountPaise: order.amountPaise,
    })
    expect(failed).toMatchObject({ ok: false, state: 'failed' })

    const succeeded = await mockPaymentProvider.completePayment({
      orderId: order.orderId,
      customerUserId: order.customerUserId,
      providerPaymentId: 'mock-payment-order-1',
      amountPaise: order.amountPaise,
    })
    expect(succeeded).toMatchObject({ ok: true, state: 'captured' })
  })
})
