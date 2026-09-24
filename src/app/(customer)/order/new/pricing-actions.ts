'use server'

import { getShop } from '@/server/domains/discovery'
import { quoteForShop, type QuoteItemRequest, type FileFactsPort, type FileFacts } from '@/server/domains/pricing'
import type { ShopCatalogue, Quote } from '@/server/domains/pricing/model'
import { findDevCatalogue } from '@/server/domains/pricing/fixtures'
import { listDraft } from '@/server/domains/files'
import {
  cancelOrderPayment,
  completeOrderPayment,
  getCustomerOrder,
  placeOrder,
  startOrderPayment,
} from '@/server/domains/orders/service'
import { paise } from '@/lib/money'
import { isErr } from '@/server/core/result'
import { customerAuthContext, readCustomerUserId } from '@/server/http/customer-identity'
import { requireCapability } from '@/server/core/rbac'
import { requireDraftOwnerId } from '@/server/http/draft-identity'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; message: string }

/** Get the catalogue for a shop so the configure panel can show what's available. */
export async function getCatalogueAction(shopSlug: string): Promise<ActionResult<ShopCatalogue>> {
  const shop = await getShop(shopSlug)
  if (!shop) return { ok: false, message: 'That shop is no longer taking orders.' }

  // For now, always use fixtures since we don't have a Postgres connection
  const catalogue = await findDevCatalogue(shopSlug)
  if (!catalogue) return { ok: false, message: 'Catalogue not found for this shop.' }

  return { ok: true, data: catalogue }
}

export interface CalculatePriceInput {
  shopSlug: string
  items: Array<{
    fileId: string
    paperSizeCode: string
    colourMode: 'bw' | 'colour'
    sides: 'single' | 'double'
    copies: number
    finishings?: Array<{ code: string; quantity?: number }>
  }>
}

/**
 * Calculate the price for configured files.
 *
 * This is a public endpoint that will be called from the client. It validates that:
 * - The files exist and belong to this user
 * - The shop exists and is live
 * - The pricing request is valid
 * - The prices are calculated correctly
 */
export async function calculatePriceAction(
  input: CalculatePriceInput,
): Promise<ActionResult<Quote>> {
  const ownerUserId = await requireDraftOwnerId()

  const shop = await getShop(input.shopSlug)
  if (!shop) return { ok: false, message: 'That shop is no longer taking orders.' }

  const userFiles = await listDraft(ownerUserId, shop.id)
  const fileIds = new Set(userFiles.map((f) => f.id))

  for (const item of input.items) {
    if (!fileIds.has(item.fileId)) {
      return { ok: false, message: 'One or more files not found.' }
    }
  }

  const quoteItems: QuoteItemRequest[] = input.items.map((item) => {
    const file = userFiles.find((f) => f.id === item.fileId)
    if (!file) throw new Error('File not found')

    return {
      ref: item.fileId,
      fileId: item.fileId,
      paperSizeCode: item.paperSizeCode,
      colourMode: item.colourMode,
      sides: item.sides,
      copies: item.copies,
      finishings: item.finishings,
    }
  })

  const filesPort: FileFactsPort = {
    async factsFor(ids: string[]) {
      const map = new Map<string, FileFacts>()
      for (const file of userFiles) {
        if (ids.includes(file.id)) {
          map.set(file.id, {
            fileId: file.id,
            pageCount: file.pageCount ?? 1,
            pageCountReliable: file.pageCountReliable ?? true,
            autoPriceableFormat: file.extension.toUpperCase() !== 'DOCX' &&
              file.extension.toUpperCase() !== 'PPT' &&
              file.extension.toUpperCase() !== 'XLSX',
            safeLabel: file.safeLabel,
          })
        }
      }
      return map
    },
  }

  const result = await quoteForShop(
    {
      shop: shop.id,
      items: quoteItems,
    },
    {
      customerId: ownerUserId,
      files: filesPort,
      settings: {
        customerPlatformFeePaise: paise(0),
        platformFeeTaxRateBps: 0,
        maxPagesPerOrder: shop.maxPagesPerOrder ?? 1000,
        maxFilesPerOrder: shop.maxFilesPerOrder ?? 50,
      },
    },
  )

  if (isErr(result)) {
    return { ok: false, message: result.error.message }
  }

  return { ok: true, data: result.value }
}

export async function payOrderAction(
  input: FormData | { orderId: string },
): Promise<ActionResult<{ id: string; orderNumber: string; totalPaise: string; state: string }>> {
  const orderId = typeof input === 'object' && 'get' in input
    ? String(input.get('orderId') ?? '')
    : input.orderId

  const customerUserId = await readCustomerUserId()
  if (!customerUserId) return { ok: false, message: 'Please continue from the customer flow to pay for this order.' }
  if (!orderId) return { ok: false, message: 'Order information is missing.' }

  const order = await getCustomerOrder(customerUserId, orderId)
  if (!order) return { ok: false, message: 'That order could not be found.' }
  const grant = requireCapability(customerAuthContext(customerUserId), 'payment.pay', { ownerUserId: order.customerUserId })
  if (isErr(grant)) return { ok: false, message: grant.error.message }

  const started = await startOrderPayment({ orderId: order.id, customerUserId, provider: 'mock' })
  if (isErr(started)) {
    return { ok: false, message: started.error.message }
  }

  const completed = await completeOrderPayment({
    orderId: order.id,
    customerUserId,
    provider: 'mock',
    providerPaymentId: started.value.providerPaymentId,
  })

  if (isErr(completed)) {
    return { ok: false, message: completed.error.message }
  }

  return {
    ok: true,
    data: {
      id: completed.value.id,
      orderNumber: completed.value.orderNumber,
      totalPaise: completed.value.totalPaise,
      state: completed.value.state,
    },
  }
}

export async function startPaymentAction(input: { orderId: string }): Promise<ActionResult<{ providerPaymentId: string }>> {
  const customerUserId = await readCustomerUserId()
  if (!customerUserId) return { ok: false, message: 'Please continue from the customer flow to pay for this order.' }
  const order = await getCustomerOrder(customerUserId, input.orderId)
  if (!order) return { ok: false, message: 'That order could not be found.' }
  const grant = requireCapability(customerAuthContext(customerUserId), 'payment.pay', { ownerUserId: order.customerUserId })
  if (isErr(grant)) return { ok: false, message: grant.error.message }
  const started = await startOrderPayment({ orderId: order.id, customerUserId, provider: 'mock' })
  if (isErr(started)) return { ok: false, message: started.error.message }
  return { ok: true, data: { providerPaymentId: started.value.providerPaymentId ?? '' } }
}

export async function completePaymentAction(input: { orderId: string; providerPaymentId: string }): Promise<ActionResult<{ state: string }>> {
  const customerUserId = await readCustomerUserId()
  if (!customerUserId) return { ok: false, message: 'Please continue from the customer flow to pay for this order.' }
  const order = await getCustomerOrder(customerUserId, input.orderId)
  if (!order) return { ok: false, message: 'That order could not be found.' }
  const grant = requireCapability(customerAuthContext(customerUserId), 'payment.pay', { ownerUserId: order.customerUserId })
  if (isErr(grant)) return { ok: false, message: grant.error.message }
  const completed = await completeOrderPayment({ orderId: order.id, customerUserId, provider: 'mock', providerPaymentId: input.providerPaymentId })
  if (isErr(completed)) return { ok: false, message: completed.error.message }
  return { ok: true, data: { state: completed.value.state } }
}

export async function cancelOrderPaymentAction(input: FormData): Promise<ActionResult<{ id: string; state: string }>> {
  const customerUserId = await readCustomerUserId()
  const orderId = String(input.get('orderId') ?? '')
  if (!customerUserId || !orderId) return { ok: false, message: 'Order information is missing.' }
  const order = await getCustomerOrder(customerUserId, orderId)
  if (!order) return { ok: false, message: 'That order could not be found.' }
  const grant = requireCapability(customerAuthContext(customerUserId), 'payment.pay', { ownerUserId: order.customerUserId })
  if (isErr(grant)) return { ok: false, message: grant.error.message }

  const result = await cancelOrderPayment({ orderId, customerUserId, provider: 'mock' })
  if (isErr(result)) return { ok: false, message: result.error.message }
  return { ok: true, data: { id: result.value.id, state: result.value.state } }
}

export async function placeOrderAction(input: {
  shopSlug: string
  fileIds: string[]
  quote: Quote
}): Promise<ActionResult<{ id: string; orderNumber: string; totalPaise: string }>> {
  const ownerUserId = await requireDraftOwnerId()

  const shop = await getShop(input.shopSlug)
  if (!shop) return { ok: false, message: 'That shop is no longer taking orders.' }

  const userFiles = await listDraft(ownerUserId, shop.id)
  const fileIds = new Set(userFiles.map((f) => f.id))
  const missing = input.fileIds.filter((id) => !fileIds.has(id))
  if (missing.length > 0) {
    return { ok: false, message: 'One or more files no longer belong to this order.' }
  }

  if (input.quote.quoteRequired) {
    return { ok: false, message: 'This job still needs a price from the shop before it can be placed.' }
  }

  const result = await placeOrder({
    customerUserId: ownerUserId,
    shopId: shop.id,
    fileIds: input.fileIds,
    quote: input.quote,
  })

  if (isErr(result)) {
    return { ok: false, message: result.error.message }
  }

  return { ok: true, data: { id: result.value.id, orderNumber: result.value.orderNumber, totalPaise: result.value.totalPaise } }
}
