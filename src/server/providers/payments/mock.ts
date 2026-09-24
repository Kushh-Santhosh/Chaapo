import type {
  PaymentIntentCancelInput,
  PaymentIntentCancelResult,
  PaymentIntentCompleteInput,
  PaymentIntentCompleteResult,
  PaymentIntentStartInput,
  PaymentIntentStartResult,
  PaymentProvider,
} from './port'

export const mockPaymentProvider: PaymentProvider = {
  name: 'mock',
  isDevelopmentProvider: true,

  async startPayment(input: PaymentIntentStartInput): Promise<PaymentIntentStartResult> {
    return {
      provider: 'mock',
      providerOrderId: `mock-order-${input.orderId}`,
      providerPaymentId: `mock-payment-${input.orderId}`,
      status: 'pending',
      checkoutUrl: `/orders/${input.orderId}?payment=mock-pending`,
    }
  },

  async completePayment(input: PaymentIntentCompleteInput): Promise<PaymentIntentCompleteResult> {
    const normalized = String(input.amountPaise)
    const failed = input.providerPaymentId.endsWith('-fail')
    return {
      ok: !failed && normalized !== '0',
      state: failed || normalized === '0' ? 'failed' : 'captured',
      providerPaymentId: input.providerPaymentId || `mock-payment-${input.orderId}`,
      reason: failed ? 'Development payment failure requested.' : normalized && normalized !== '0' ? undefined : 'No amount captured',
    }
  },

  async cancelPayment(input: PaymentIntentCancelInput): Promise<PaymentIntentCancelResult> {
    return {
      ok: true,
      providerPaymentId: input.providerPaymentId,
    }
  },
}
