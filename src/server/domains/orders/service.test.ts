import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { devFileStore, resetDevFileStore } from '../files/dev-store'
import {
  getCustomerOrder,
  getShopOrder,
  listCustomerOrders,
  listShopOrders,
  completeOrderPayment,
  cancelOrderPayment,
  startOrderPayment,
  placeOrder,
  resetDevOrderStore,
  transitionOrder,
} from './service'

describe('placeOrder', () => {
  it('persists the dev order store on disk so the customer and shop views can share one real order', async () => {
    resetDevFileStore()
    resetDevOrderStore()
    const persistedPath = join(process.cwd(), '.chaapo-orders.json')

    const first = await devFileStore.reserve({
      ownerUserId: 'customer-persist',
      shopId: 'shop-1',
      originalNameEncrypted: 'enc-persist',
      safeLabel: 'Persist.pdf',
      extension: 'pdf',
      declaredMime: 'application/pdf',
      declaredSizeBytes: 4321,
      storageBucket: 'prints',
      storageKey: 'drafts/customer-persist/persist.pdf',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      urlExpiresAt: new Date(Date.now() + 1800_000).toISOString(),
    })

    await devFileStore.complete(first.fileId, 'customer-persist', {
      byteSize: 4321,
      contentSha256: 'persist-sha',
      detectedMime: 'application/pdf',
      mimeMismatch: false,
      pageCount: 2,
      pageCountReliable: true,
      dominantPageSize: 'A4',
      hasMixedPageSizes: false,
      pageSizes: [],
      isPasswordProtected: false,
      isCorrupt: false,
      processingError: null,
    })

    const result = await placeOrder({
      customerUserId: 'customer-persist',
      shopId: 'shop-1',
      fileIds: [first.fileId],
      quote: {
        shopId: 'shop-1',
        items: [{
          ref: first.fileId,
          fileId: first.fileId,
          label: 'Persist.pdf',
          pages: 2,
          billableSides: 2,
          sheets: 2,
          copies: 1,
          lines: [],
          totalPaise: '420',
        }],
        totals: {
          itemsSubtotalPaise: '420',
          minOrderTopUpPaise: '0',
          subtotalPaise: '420',
          platformFeePaise: '0',
          taxPaise: '0',
          totalPaise: '420',
        },
        quoteRequired: false,
        blocks: [],
        estimatedMinutes: 20,
        computedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        pricingBasis: [],
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('persist order should be ok')
    expect(existsSync(persistedPath)).toBe(true)

    const persisted = JSON.parse(readFileSync(persistedPath, 'utf8'))
    expect(Array.isArray(persisted)).toBe(true)
    expect(persisted.some((order: { id: string }) => order.id === result.value.id)).toBe(true)
  })

  it('creates a real order and attaches the uploaded files to it', async () => {
    resetDevFileStore()
    resetDevOrderStore()

    const first = await devFileStore.reserve({
      ownerUserId: 'customer-1',
      shopId: 'shop-1',
      originalNameEncrypted: 'enc-1',
      safeLabel: 'File 1.pdf',
      extension: 'pdf',
      declaredMime: 'application/pdf',
      declaredSizeBytes: 1234,
      storageBucket: 'prints',
      storageKey: 'drafts/customer-1/file-1.pdf',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      urlExpiresAt: new Date(Date.now() + 1800_000).toISOString(),
    })

    await devFileStore.complete(first.fileId, 'customer-1', {
      byteSize: 1234,
      contentSha256: 'abc',
      detectedMime: 'application/pdf',
      mimeMismatch: false,
      pageCount: 2,
      pageCountReliable: true,
      dominantPageSize: 'A4',
      hasMixedPageSizes: false,
      pageSizes: [],
      isPasswordProtected: false,
      isCorrupt: false,
      processingError: null,
    })

    const result = await placeOrder({
      customerUserId: 'customer-1',
      shopId: 'shop-1',
      fileIds: [first.fileId],
      quote: {
        shopId: 'shop-1',
        items: [
          {
            ref: first.fileId,
            fileId: first.fileId,
            label: 'File 1.pdf',
            pages: 2,
            billableSides: 2,
            sheets: 2,
            copies: 1,
            lines: [],
            totalPaise: '100',
          },
        ],
        totals: {
          itemsSubtotalPaise: '100',
          minOrderTopUpPaise: '0',
          subtotalPaise: '100',
          platformFeePaise: '0',
          taxPaise: '0',
          totalPaise: '100',
        },
        quoteRequired: false,
        blocks: [],
        estimatedMinutes: 20,
        computedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        pricingBasis: [],
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('result should be ok')
    expect(result.value.orderNumber).toMatch(/^CHP-/)
    expect(result.value.totalPaise).toBe('100')

    const updated = await devFileStore.get(first.fileId, 'customer-1')
    expect(updated?.orderId).toBe(result.value.id)
  })

  it('lists and fetches a customer order from the dev order store', async () => {
    resetDevFileStore()
    resetDevOrderStore()

    const first = await devFileStore.reserve({
      ownerUserId: 'customer-history',
      shopId: 'shop-1',
      originalNameEncrypted: 'enc-history',
      safeLabel: 'File 1.pdf',
      extension: 'pdf',
      declaredMime: 'application/pdf',
      declaredSizeBytes: 1234,
      storageBucket: 'prints',
      storageKey: 'drafts/customer-history/file-1.pdf',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      urlExpiresAt: new Date(Date.now() + 1800_000).toISOString(),
    })

    await devFileStore.complete(first.fileId, 'customer-history', {
      byteSize: 1234,
      contentSha256: 'abc',
      detectedMime: 'application/pdf',
      mimeMismatch: false,
      pageCount: 2,
      pageCountReliable: true,
      dominantPageSize: 'A4',
      hasMixedPageSizes: false,
      pageSizes: [],
      isPasswordProtected: false,
      isCorrupt: false,
      processingError: null,
    })

    const result = await placeOrder({
      customerUserId: 'customer-history',
      shopId: 'shop-1',
      fileIds: [first.fileId],
      quote: {
        shopId: 'shop-1',
        items: [{
          ref: first.fileId,
          fileId: first.fileId,
          label: 'File 1.pdf',
          pages: 2,
          billableSides: 2,
          sheets: 2,
          copies: 1,
          lines: [],
          totalPaise: '200',
        }],
        totals: {
          itemsSubtotalPaise: '200',
          minOrderTopUpPaise: '0',
          subtotalPaise: '200',
          platformFeePaise: '0',
          taxPaise: '0',
          totalPaise: '200',
        },
        quoteRequired: false,
        blocks: [],
        estimatedMinutes: 20,
        computedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        pricingBasis: [],
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('result should be ok')

    const list = await listCustomerOrders('customer-history')
    expect(list).toHaveLength(1)
    expect(list[0]?.orderNumber).toBe(result.value.orderNumber)

    const order = await getCustomerOrder('customer-history', result.value.id)
    expect(order?.id).toBe(result.value.id)
    expect(order?.state).toBe('payment_pending')

    const blocked = await transitionOrder({ orderId: result.value.id, shopId: 'shop-1', action: 'accept' })
    expect(blocked.ok).toBe(false)
    if (blocked.ok) throw new Error('unpaid order should not be accepted')
    expect(blocked.error.code).toBe('payment_required')

    const cancelled = await cancelOrderPayment({ orderId: result.value.id, customerUserId: 'customer-history' })
    expect(cancelled.ok).toBe(true)
    if (!cancelled.ok) throw new Error('payment should cancel')
    expect(cancelled.value.paymentStatus).toBe('cancelled')

    const retry = await startOrderPayment({ orderId: result.value.id, customerUserId: 'customer-history' })
    expect(retry.ok).toBe(true)
    if (!retry.ok) throw new Error('cancelled payment should be retryable')
  })

  it('completes a payment for a customer-held order and moves it to placed', async () => {
    resetDevFileStore()
    resetDevOrderStore()

    const file = await devFileStore.reserve({
      ownerUserId: 'customer-payment',
      shopId: 'shop-1',
      originalNameEncrypted: 'enc-payment',
      safeLabel: 'Payment.pdf',
      extension: 'pdf',
      declaredMime: 'application/pdf',
      declaredSizeBytes: 2000,
      storageBucket: 'prints',
      storageKey: 'drafts/customer-payment/payment.pdf',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      urlExpiresAt: new Date(Date.now() + 1800_000).toISOString(),
    })

    await devFileStore.complete(file.fileId, 'customer-payment', {
      byteSize: 2000,
      contentSha256: 'payment-sha',
      detectedMime: 'application/pdf',
      mimeMismatch: false,
      pageCount: 3,
      pageCountReliable: true,
      dominantPageSize: 'A4',
      hasMixedPageSizes: false,
      pageSizes: [],
      isPasswordProtected: false,
      isCorrupt: false,
      processingError: null,
    })

    const placed = await placeOrder({
      customerUserId: 'customer-payment',
      shopId: 'shop-1',
      fileIds: [file.fileId],
      quote: {
        shopId: 'shop-1',
        items: [{
          ref: file.fileId,
          fileId: file.fileId,
          label: 'Payment.pdf',
          pages: 3,
          billableSides: 2,
          sheets: 3,
          copies: 1,
          lines: [],
          totalPaise: '300',
        }],
        totals: {
          itemsSubtotalPaise: '300',
          minOrderTopUpPaise: '0',
          subtotalPaise: '300',
          platformFeePaise: '0',
          taxPaise: '0',
          totalPaise: '300',
        },
        quoteRequired: false,
        blocks: [],
        estimatedMinutes: 20,
        computedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        pricingBasis: [],
      },
    })

    expect(placed.ok).toBe(true)
    if (!placed.ok) throw new Error('place order should be ok')

    const failed = await completeOrderPayment({
      customerUserId: 'customer-payment',
      orderId: placed.value.id,
      provider: 'mock',
      providerPaymentId: 'mock-payment-123-fail',
    })

    expect(failed.ok).toBe(false)
    if (failed.ok) throw new Error('payment should fail')
    expect(failed.error.code).toBe('payment_failed')

    const retryStarted = await startOrderPayment({ orderId: placed.value.id, customerUserId: 'customer-payment' })
    expect(retryStarted.ok).toBe(true)
    if (!retryStarted.ok) throw new Error('failed payment should be retryable')

    const paid = await completeOrderPayment({
      customerUserId: 'customer-payment',
      orderId: placed.value.id,
      provider: 'mock',
      providerPaymentId: retryStarted.value.providerPaymentId,
    })

    expect(paid.ok).toBe(true)
    if (!paid.ok) throw new Error('retry payment should complete')
    expect(paid.value.state).toBe('placed')

    const stored = await getCustomerOrder('customer-payment', placed.value.id)
    expect(stored?.state).toBe('placed')
    expect(stored?.paymentStatus).toBe('captured')

    const duplicate = await completeOrderPayment({
      customerUserId: 'customer-payment',
      orderId: placed.value.id,
      provider: 'mock',
      providerPaymentId: retryStarted.value.providerPaymentId,
    })
    expect(duplicate.ok).toBe(true)
    if (!duplicate.ok) throw new Error('duplicate payment should be idempotent')
    expect(duplicate.value.id).toBe(placed.value.id)

    const unauthorized = await completeOrderPayment({
      customerUserId: 'another-customer',
      orderId: placed.value.id,
      provider: 'mock',
      providerPaymentId: retryStarted.value.providerPaymentId,
    })
    expect(unauthorized.ok).toBe(false)
    if (unauthorized.ok) throw new Error('another customer must not pay this order')
    expect(unauthorized.error.code).toBe('forbidden')
  })

  it('lets a shop see only its own orders and enforces valid transitions', async () => {
    resetDevFileStore()
    resetDevOrderStore()

    const file = await devFileStore.reserve({
      ownerUserId: 'customer-shop-flow',
      shopId: 'shop-1',
      originalNameEncrypted: 'enc-shop-flow',
      safeLabel: 'Flow.pdf',
      extension: 'pdf',
      declaredMime: 'application/pdf',
      declaredSizeBytes: 1000,
      storageBucket: 'prints',
      storageKey: 'drafts/customer-shop-flow/flow.pdf',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      urlExpiresAt: new Date(Date.now() + 1800_000).toISOString(),
    })

    await devFileStore.complete(file.fileId, 'customer-shop-flow', {
      byteSize: 1000,
      contentSha256: 'abc',
      detectedMime: 'application/pdf',
      mimeMismatch: false,
      pageCount: 2,
      pageCountReliable: true,
      dominantPageSize: 'A4',
      hasMixedPageSizes: false,
      pageSizes: [],
      isPasswordProtected: false,
      isCorrupt: false,
      processingError: null,
    })

    const placed = await placeOrder({
      customerUserId: 'customer-shop-flow',
      shopId: 'shop-1',
      fileIds: [file.fileId],
      quote: {
        shopId: 'shop-1',
        items: [{
          ref: file.fileId,
          fileId: file.fileId,
          label: 'Flow.pdf',
          pages: 2,
          billableSides: 2,
          sheets: 2,
          copies: 1,
          lines: [],
          totalPaise: '250',
        }],
        totals: {
          itemsSubtotalPaise: '250',
          minOrderTopUpPaise: '0',
          subtotalPaise: '250',
          platformFeePaise: '0',
          taxPaise: '0',
          totalPaise: '250',
        },
        quoteRequired: false,
        blocks: [],
        estimatedMinutes: 20,
        computedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        pricingBasis: [],
      },
    })

    expect(placed.ok).toBe(true)
    if (!placed.ok) throw new Error('place order should be ok')

    const started = await startOrderPayment({ orderId: placed.value.id, customerUserId: 'customer-shop-flow' })
    expect(started.ok).toBe(true)
    if (!started.ok) throw new Error('payment should start')
    const paid = await completeOrderPayment({
      orderId: placed.value.id,
      customerUserId: 'customer-shop-flow',
      provider: 'mock',
      providerPaymentId: started.value.providerPaymentId,
    })
    expect(paid.ok).toBe(true)

    const shopOrders = await listShopOrders('shop-1')
    const otherShopOrders = await listShopOrders('shop-2')
    expect(shopOrders.some((order) => order.id === placed.value.id)).toBe(true)
    expect(otherShopOrders.some((order) => order.id === placed.value.id)).toBe(false)

    const own = await getShopOrder('shop-1', placed.value.id)
    const otherShop = await getShopOrder('shop-2', placed.value.id)
    expect(own?.id).toBe(placed.value.id)
    expect(otherShop).toBeNull()

    const accepted = await transitionOrder({ orderId: placed.value.id, shopId: 'shop-1', action: 'accept' })
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error('accept should be ok')
    expect(accepted.value.state).toBe('accepted')

    const invalid = await transitionOrder({ orderId: placed.value.id, shopId: 'shop-1', action: 'reject' })
    expect(invalid.ok).toBe(false)
    if (invalid.ok) throw new Error('reject should fail')
    expect(invalid.error.code).toBe('invalid_transition')

    const printing = await transitionOrder({ orderId: placed.value.id, shopId: 'shop-1', action: 'start_printing' })
    expect(printing.ok).toBe(true)
    if (!printing.ok) throw new Error('start_printing should succeed')
    expect(printing.value.state).toBe('printing')

    const ready = await transitionOrder({ orderId: placed.value.id, shopId: 'shop-1', action: 'mark_ready' })
    expect(ready.ok).toBe(true)
    if (!ready.ok) throw new Error('mark_ready should succeed')
    expect(ready.value.state).toBe('ready')

    const fulfilled = await transitionOrder({ orderId: placed.value.id, shopId: 'shop-1', action: 'mark_collected' })
    expect(fulfilled.ok).toBe(true)
    if (!fulfilled.ok) throw new Error('mark_collected should succeed')
    expect(fulfilled.value.state).toBe('collected')

    const settled = await transitionOrder({ orderId: placed.value.id, shopId: 'shop-1', action: 'settle' })
    expect(settled.ok).toBe(true)
    if (!settled.ok) throw new Error('settle should succeed')
    expect(settled.value.state).toBe('settled')

    const customer = await getCustomerOrder('customer-shop-flow', placed.value.id)
    expect(customer?.state).toBe('settled')
  })
})
