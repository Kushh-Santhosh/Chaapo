import { errors } from '../../core/errors'
import { mockPaymentProvider } from './mock'
import type { PaymentProvider } from './port'

export function getPaymentProvider(provider: 'mock' | 'razorpay' = 'mock'): PaymentProvider {
  if (provider === 'mock') return mockPaymentProvider

  throw errors.notImplemented('Razorpay payment provider')
}

export type {
  PaymentProvider,
  PaymentProviderId,
  PaymentIntentStartInput,
  PaymentIntentStartResult,
  PaymentIntentCompleteInput,
  PaymentIntentCompleteResult,
  PaymentIntentCancelInput,
  PaymentIntentCancelResult,
} from './port'
