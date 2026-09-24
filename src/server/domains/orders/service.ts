import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { newId, newOrderNumber } from '../../../lib/ids'
import { type AppError, errors } from '../../core/errors'
import { ok, err, type Result } from '../../core/result'

import { attachFilesToOrder, listDraft } from '../files'
import { cancelPayment, completePayment, initiatePayment } from '../payments/service'
import type { Quote } from '../pricing/model'

export interface PlaceOrderInput {
  customerUserId: string
  shopId: string
  fileIds: string[]
  quote: Quote
}

export type OrderLifecycleState =
  | 'draft'
  | 'awaiting_quote'
  | 'payment_pending'
  | 'failed'
  | 'placed'
  | 'accepted'
  | 'printing'
  | 'on_hold_file_issue'
  | 'ready'
  | 'collected'
  | 'settled'
  | 'rejected'
  | 'auto_cancelled'
  | 'cancelled_by_customer'
  | 'cancelled_by_shop'
  | 'expired'
  | 'refunded'
  | 'partially_refunded'
  | 'closed_no_refund'
  | 'disputed'

export interface PlaceOrderResult {
  id: string
  orderNumber: string
  totalPaise: string
  shopId: string
  customerUserId: string
  fileIds: string[]
  state: OrderLifecycleState
}

export interface StoredOrder extends PlaceOrderResult {
  createdAt: string
  updatedAt: string
  paymentStatus?: 'pending' | 'captured' | 'failed' | 'cancelled'
  paymentProvider?: 'mock' | 'razorpay'
  providerPaymentId?: string
  paymentAttempt?: number
  paymentIdempotencyKey?: string
}

export type OrderAction = 'accept' | 'reject' | 'start_printing' | 'mark_ready' | 'mark_collected' | 'settle'

const DEV_ORDER_STORE = resolve(process.cwd(), '.chaapo-orders.json')

function writeDevOrderStore(): void {
  const payload = JSON.stringify([...DEV_ORDERS.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), null, 2)
  writeFileSync(DEV_ORDER_STORE, payload, 'utf8')
}

function loadDevOrderStore(): Map<string, StoredOrder> {
  try {
    const raw = readFileSync(DEV_ORDER_STORE, 'utf8')
    const parsed = JSON.parse(raw) as StoredOrder[] | null
    if (!Array.isArray(parsed)) return new Map()
    return new Map(parsed.map((order) => [order.id, order]))
  } catch {
    return new Map()
  }
}

const DEV_ORDERS = loadDevOrderStore()

export function resetDevOrderStore(): void {
  DEV_ORDERS.clear()
  try {
    writeDevOrderStore()
  } catch {
    // Ignore disk write failures in development; the in-memory map is still reset.
  }
}

export async function listCustomerOrders(customerUserId: string): Promise<StoredOrder[]> {
  return [...DEV_ORDERS.values()]
    .filter((order) => order.customerUserId === customerUserId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function listShopOrders(shopId: string): Promise<StoredOrder[]> {
  return [...DEV_ORDERS.values()]
    .filter((order) => order.shopId === shopId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function getCustomerOrder(
  customerUserId: string,
  orderId: string,
): Promise<StoredOrder | null> {
  const order = DEV_ORDERS.get(orderId)
  if (!order || order.customerUserId !== customerUserId) return null
  return order
}

export async function getShopOrder(shopId: string, orderId: string): Promise<StoredOrder | null> {
  const order = DEV_ORDERS.get(orderId)
  if (!order || order.shopId !== shopId) return null
  return order
}

export async function startOrderPayment(params: {
  orderId: string
  customerUserId: string
  provider?: 'mock' | 'razorpay'
}): Promise<Result<StoredOrder, AppError>> {
  const order = DEV_ORDERS.get(params.orderId)
  if (!order) return err(errors.notFound('Order'))
  if (order.customerUserId !== params.customerUserId) {
    return err(errors.forbidden('This order does not belong to this customer.'))
  }
  if (!['payment_pending', 'failed'].includes(order.state)) {
    return err(errors.invalidTransition({
      from: order.state,
      event: 'payment.start',
      message: 'This order is not ready to start a payment.',
    }))
  }

  const providerName = params.provider ?? 'mock'
  const started = await initiatePayment({
    orderId: order.id,
    customerUserId: order.customerUserId,
    shopId: order.shopId,
    amountPaise: order.totalPaise,
  }, providerName)

  const updated: StoredOrder = {
    ...order,
    paymentStatus: started.status === 'captured' ? 'captured' : 'pending',
    paymentProvider: started.provider,
    providerPaymentId: started.providerPaymentId,
    paymentAttempt: (order.paymentAttempt ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  }
  DEV_ORDERS.set(order.id, updated)
  try {
    writeDevOrderStore()
  } catch {
    // Best effort persistence in development; the request can still continue.
  }
  return ok(updated)
}

export async function completeOrderPayment(params: {
  orderId: string
  customerUserId: string
  provider: 'mock' | 'razorpay'
  providerPaymentId?: string
}): Promise<Result<StoredOrder, AppError>> {
  const order = DEV_ORDERS.get(params.orderId)
  if (!order) return err(errors.notFound('Order'))
  if (order.customerUserId !== params.customerUserId) {
    return err(errors.forbidden('This order does not belong to this customer.'))
  }
  if (order.paymentStatus === 'captured' || order.state === 'placed') return ok(order)
  if (!['payment_pending', 'failed'].includes(order.state)) {
    return err(errors.invalidTransition({
      from: order.state,
      event: 'payment.complete',
      message: 'This order is not waiting on a payment completion.',
    }))
  }

  const result = await completePayment({
    orderId: order.id,
    customerUserId: order.customerUserId,
    shopId: order.shopId,
    amountPaise: order.totalPaise,
    providerId: params.provider,
    providerPaymentId: params.providerPaymentId ?? order.providerPaymentId ?? `provider-${order.id}`,
  })

  if (!result.ok) {
    const updated: StoredOrder = {
      ...order,
      state: 'failed',
      paymentStatus: 'failed',
      providerPaymentId: params.providerPaymentId ?? order.providerPaymentId,
      paymentAttempt: (order.paymentAttempt ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    }
    DEV_ORDERS.set(order.id, updated)
    try {
      writeDevOrderStore()
    } catch {
      // Best effort persistence in development; the request can still continue.
    }
    return err(errors.paymentFailed(result.reason ?? 'That payment did not go through.'))
  }

  const updated: StoredOrder = {
    ...order,
    state: 'placed',
    paymentStatus: 'captured',
    paymentProvider: params.provider,
    providerPaymentId: params.providerPaymentId ?? order.providerPaymentId ?? `provider-${order.id}`,
    updatedAt: new Date().toISOString(),
  }
  DEV_ORDERS.set(order.id, updated)
  try {
    writeDevOrderStore()
  } catch {
    // Best effort persistence in development; the request can still continue.
  }
  return ok(updated)
}

export async function cancelOrderPayment(params: {
  orderId: string
  customerUserId: string
  provider?: 'mock' | 'razorpay'
}): Promise<Result<StoredOrder, AppError>> {
  const order = DEV_ORDERS.get(params.orderId)
  if (!order) return err(errors.notFound('Order'))
  if (order.customerUserId !== params.customerUserId) {
    return err(errors.forbidden('This order does not belong to this customer.'))
  }
  if (order.paymentStatus === 'captured' || order.state === 'placed') return ok(order)
  if (!['payment_pending', 'failed'].includes(order.state)) {
    return err(errors.invalidTransition({
      from: order.state,
      event: 'payment.cancel',
      message: 'This order cannot cancel its payment now.',
    }))
  }

  const providerId = params.provider ?? order.paymentProvider ?? 'mock'
  const result = await cancelPayment({
    orderId: order.id,
    customerUserId: order.customerUserId,
    providerId,
    providerPaymentId: order.providerPaymentId ?? `provider-${order.id}`,
  })
  if (!result.ok) return err(errors.paymentFailed(result.reason ?? 'The payment could not be cancelled.'))

  const updated: StoredOrder = {
    ...order,
    state: 'failed',
    paymentStatus: 'cancelled',
    paymentProvider: providerId,
    updatedAt: new Date().toISOString(),
  }
  DEV_ORDERS.set(order.id, updated)
  try { writeDevOrderStore() } catch { /* best effort dev persistence */ }
  return ok(updated)
}

export async function placeOrder(input: PlaceOrderInput): Promise<Result<PlaceOrderResult>> {
  if (input.fileIds.length === 0) {
    return err(errors.validation([{ path: 'files', message: 'Add at least one file.' }]))
  }

  const owned = await listDraft(input.customerUserId, input.shopId)
  const ownedIds = new Set(owned.map((file) => file.id))
  const missing = input.fileIds.filter((fileId) => !ownedIds.has(fileId))
  if (missing.length > 0) {
    return err(errors.notFound('One of those files', 'One of those files is no longer available.'))
  }

  const orderId = newId()
  const orderNumber = newOrderNumber()
  const totalPaise = input.quote.totals.totalPaise

  const ready = owned.filter((file) => input.fileIds.includes(file.id) && file.state === 'ready')
  if (ready.length !== input.fileIds.length) {
    return err(errors.preconditionFailed('One of those files is still being checked.'))
  }

  const state: PlaceOrderResult['state'] = input.quote.quoteRequired ? 'awaiting_quote' : 'payment_pending'

  const attach = await attachFilesToOrder({
    customerUserId: input.customerUserId,
    shopId: input.shopId,
    orderId,
    fileIds: [...input.fileIds],
  })
  if (attach.ok === false) return attach

  const now = new Date().toISOString()
  const order: PlaceOrderResult = {
    id: orderId,
    orderNumber,
    totalPaise,
    shopId: input.shopId,
    customerUserId: input.customerUserId,
    fileIds: [...input.fileIds],
    state,
  }

  const stored: StoredOrder = {
    ...order,
    createdAt: now,
    updatedAt: now,
  }
  DEV_ORDERS.set(orderId, stored)
  try {
    writeDevOrderStore()
  } catch {
    // Best effort persistence in development; the request can still continue.
  }

  return ok(order)
}

export async function transitionOrder(params: {
  orderId: string
  shopId: string
  action: OrderAction
}): Promise<Result<StoredOrder, AppError>> {
  const order = DEV_ORDERS.get(params.orderId)
  if (!order) return err(errors.notFound('Order'))
  if (order.shopId !== params.shopId) {
    return err(errors.forbidden('This order does not belong to this shop.'))
  }

  const nextStateByAction: Record<OrderAction, OrderLifecycleState> = {
    accept: 'accepted',
    reject: 'rejected',
    start_printing: 'printing',
    mark_ready: 'ready',
    mark_collected: 'collected',
    settle: 'settled',
  }

  const allowedByState: Record<OrderLifecycleState, OrderAction[]> = {
    draft: ['accept'],
    awaiting_quote: ['accept', 'reject'],
    payment_pending: [],
    failed: [],
    placed: ['accept', 'reject'],
    accepted: ['start_printing'],
    printing: ['mark_ready'],
    'on_hold_file_issue': ['accept', 'reject'],
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
  }

  const currentState = order.state
  if (order.paymentStatus !== 'captured' && ['accept', 'start_printing', 'mark_ready', 'mark_collected', 'settle'].includes(params.action)) {
    return err(errors.paymentRequired('Payment must be captured before fulfillment can begin.'))
  }

  const allowedActions = allowedByState[currentState] ?? []
  if (!allowedActions.includes(params.action)) {
    return err(
      errors.invalidTransition({
        from: currentState,
        event: params.action,
        message: 'This order cannot be progressed in its current state.',
      }),
    )
  }

  const nextState = nextStateByAction[params.action]
  const updated: StoredOrder = {
    ...order,
    state: nextState,
    updatedAt: new Date().toISOString(),
  }
  DEV_ORDERS.set(params.orderId, updated)
  try {
    writeDevOrderStore()
  } catch {
    // Best effort persistence in development; the request can still continue.
  }
  return ok(updated)
}
