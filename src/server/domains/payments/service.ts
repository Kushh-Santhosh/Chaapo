import { getPaymentProvider, type PaymentProviderId } from '@/server/providers/payments'

export interface PaymentOrderContext {
  orderId: string
  customerUserId: string
  shopId: string
  amountPaise: string
}

export async function initiatePayment(
  order: PaymentOrderContext,
  providerId: PaymentProviderId = 'mock',
) {
  return getPaymentProvider(providerId).startPayment(order)
}

export async function completePayment(input: PaymentOrderContext & {
  providerId: PaymentProviderId
  providerPaymentId: string
}) {
  return getPaymentProvider(input.providerId).completePayment({
    orderId: input.orderId,
    customerUserId: input.customerUserId,
    providerPaymentId: input.providerPaymentId,
    amountPaise: input.amountPaise,
  })
}

export async function cancelPayment(input: {
  orderId: string
  customerUserId: string
  providerId: PaymentProviderId
  providerPaymentId: string
}) {
  return getPaymentProvider(input.providerId).cancelPayment({
    orderId: input.orderId,
    customerUserId: input.customerUserId,
    providerPaymentId: input.providerPaymentId,
  })
}
