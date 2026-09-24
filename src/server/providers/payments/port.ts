export type PaymentProviderId = 'mock' | 'razorpay'

export interface PaymentIntentStartInput {
  orderId: string
  customerUserId: string
  shopId: string
  amountPaise: string
  currency?: 'INR'
}

export interface PaymentIntentStartResult {
  provider: PaymentProviderId
  providerOrderId: string
  providerPaymentId: string
  status: 'pending' | 'captured'
  checkoutUrl?: string
}

export interface PaymentIntentCompleteInput {
  orderId: string
  customerUserId: string
  providerPaymentId: string
  amountPaise: string
}

export interface PaymentIntentCompleteResult {
  ok: boolean
  state: 'captured' | 'failed'
  providerPaymentId: string
  reason?: string
}

export interface PaymentIntentCancelInput {
  orderId: string
  customerUserId: string
  providerPaymentId: string
}

export interface PaymentIntentCancelResult {
  ok: boolean
  providerPaymentId: string
  reason?: string
}

export interface PaymentProvider {
  readonly name: string
  readonly isDevelopmentProvider: boolean
  startPayment(input: PaymentIntentStartInput): Promise<PaymentIntentStartResult>
  completePayment(input: PaymentIntentCompleteInput): Promise<PaymentIntentCompleteResult>
  cancelPayment(input: PaymentIntentCancelInput): Promise<PaymentIntentCancelResult>
}
