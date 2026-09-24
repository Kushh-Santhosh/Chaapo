'use client'

import { useCallback, useState, useTransition } from 'react'

import { UploadPanel } from './upload-panel'
import { ConfigurePanel, type FileConfiguration } from './configure-panel'
import { calculatePriceAction, completePaymentAction, placeOrderAction, startPaymentAction } from './pricing-actions'
import type { DraftView } from './actions'
import type { ShopCatalogue, Quote } from '@/server/domains/pricing/model'
import { Card, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { StickyActionBar } from '@/components/shell/sticky-action-bar'

type Step = 'upload' | 'configure' | 'price'

export interface OrderFlowProps {
  shopSlug: string
  shopName: string
  initialDraft: DraftView
  maxFiles: number | null
  maxPages: number | null
  developmentStorage: boolean
  catalogue: ShopCatalogue
}

export function OrderFlow({
  shopSlug,
  shopName,
  initialDraft,
  maxFiles,
  maxPages,
  developmentStorage,
  catalogue,
}: OrderFlowProps) {
  const [step, setStep] = useState<Step>('upload')
  const [draft, setDraft] = useState<DraftView>(initialDraft)
  const [quote, setQuote] = useState<Quote | null>(null)
  const [calculating, startCalculating] = useTransition()
  const [placing, startPlacing] = useTransition()
  const [priceError, setPriceError] = useState<string | null>(null)
  const [placeError, setPlaceError] = useState<string | null>(null)
  const [placedOrder, setPlacedOrder] = useState<{ id: string; orderNumber: string; totalPaise?: string; providerPaymentId?: string; paymentState: 'pending' | 'captured' } | null>(null)

  const readyFiles = draft.files.filter((f) => f.state === 'ready')
  const hasReadyFiles = readyFiles.length > 0

  // When files are uploaded, automatically move to configure if all are ready
  const handleUploadComplete = useCallback((newDraft: DraftView) => {
    setDraft(newDraft)
    const newReady = newDraft.files.filter((f) => f.state === 'ready')
    // Move to configure automatically if we have ready files
    if (newReady.length > 0 && newReady.length === newDraft.files.length) {
      setStep('configure')
    }
  }, [])

  const handleConfigureContinue = (_newConfigs: FileConfiguration[]) => {
    setPriceError(null)
    
    startCalculating(async () => {
      const result = await calculatePriceAction({
        shopSlug,
        items: _newConfigs,
      })
      
      if (!result.ok) {
        setPriceError(result.message)
        return
      }
      
      setQuote(result.data)
      setStep('price')
    })
  }

  const handleBackToUpload = () => {
    setStep('upload')
    setQuote(null)
    setPriceError(null)
    setPlaceError(null)
    setPlacedOrder(null)
  }

  const handleBackToConfigure = () => {
    setStep('configure')
    setQuote(null)
    setPriceError(null)
    setPlaceError(null)
    setPlacedOrder(null)
  }

  const handlePlaceOrder = () => {
    if (!quote) return
    setPlaceError(null)

    startPlacing(async () => {
      const result = await placeOrderAction({
        shopSlug,
        fileIds: quote.items.map((item) => item.fileId),
        quote,
      })

      if (!result.ok) {
        setPlaceError(result.message)
        return
      }

      const order = { id: result.data.id, orderNumber: result.data.orderNumber, totalPaise: result.data.totalPaise }
      setPlacedOrder({ ...order, paymentState: 'pending' })
    })
  }

  const handleStartPayment = () => {
    if (!placedOrder) return
    setPlaceError(null)
    startPlacing(async () => {
      const result = await startPaymentAction({ orderId: placedOrder.id })
      if (!result.ok) {
        setPlaceError(result.message)
        return
      }
      setPlacedOrder({ ...placedOrder, providerPaymentId: result.data.providerPaymentId })
    })
  }

  const handleCompletePayment = () => {
    if (!placedOrder?.providerPaymentId) return
    setPlaceError(null)
    startPlacing(async () => {
      const result = await completePaymentAction({ orderId: placedOrder.id, providerPaymentId: placedOrder.providerPaymentId ?? '' })
      if (!result.ok) {
        setPlaceError(result.message)
        return
      }
      setPlacedOrder({ ...placedOrder, paymentState: 'captured' })
    })
  }

  if (step === 'upload') {
    return (
      <UploadPanel
        shopSlug={shopSlug}
        shopName={shopName}
        initialDraft={draft}
        maxFiles={maxFiles}
        maxPages={maxPages}
        developmentStorage={developmentStorage}
        onUploadChange={handleUploadComplete}
        onContinueToOptions={() => setStep('configure')}
      />
    )
  }

  if (step === 'configure' && hasReadyFiles) {
    return (
      <ConfigurePanel
        files={readyFiles}
        catalogue={catalogue}
        onContinue={handleConfigureContinue}
        onBack={handleBackToUpload}
        calculating={calculating}
        error={priceError}
      />
    )
  }

  // Price step
  if (step === 'price' && quote) {
    const totalRupees = (Number(quote.totals.totalPaise) / 100).toFixed(2)
    const expiresAt = new Date(quote.expiresAt)
    const now = new Date()
    const minutesRemaining = Math.floor((expiresAt.getTime() - now.getTime()) / 60000)

    return (
      <div className="space-y-6 pb-2">
        <header className="px-4 pt-4">
          <button
            onClick={handleBackToConfigure}
            className="inline-flex items-center gap-1 text-sm text-ink-3 transition-colors hover:text-ink"
          >
            <span>←</span> Back to options
          </button>
          <h1 className="mt-2 font-display text-3xl leading-tight text-ink">Your quote</h1>
        </header>

        <div className="space-y-4 px-4">
          {/* Quote breakdown */}
          <Card>
            <CardHeader>Quote breakdown</CardHeader>
            <div className="space-y-3 px-4 pb-4">
              {quote.items.map((item) => (
                <div key={item.ref}>
                  <div className="text-sm">
                    <p className="font-medium text-ink">{item.label}</p>
                    <p className="text-xs text-ink-2">{item.pages} pages · {item.copies} copies</p>
                  </div>
                  <div className="space-y-1 text-xs">
                    {item.lines.map((line, idx) => (
                      <div key={idx} className="flex justify-between text-ink-2">
                        <span>{line.label}</span>
                        <span>₹{(Number(line.amountPaise) / 100).toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 border-t border-ink-3 pt-2 text-sm font-medium">
                    <div className="flex justify-between">
                      <span>Item total</span>
                      <span>₹{(Number(item.totalPaise) / 100).toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              ))}

              <div className="border-t-2 border-ink-3 pt-3 font-medium">
                <div className="flex justify-between text-base">
                  <span>Order total</span>
                  <span>₹{totalRupees}</span>
                </div>
              </div>
            </div>
          </Card>
        </div>

        {placedOrder ? (
          <div className="space-y-4 px-4">
            <Card>
              <CardHeader>Order placed</CardHeader>
              <div className="space-y-2 px-4 pb-4 text-sm">
                <p className="text-ink">Your order has been created. Payment: {placedOrder.paymentState}.</p>
                <p className="font-mono text-base text-ink">{placedOrder.orderNumber}</p>
                <p className="text-ink-2">We saved your files. Complete payment before the shop can start work.</p>
              </div>
            </Card>
          </div>
        ) : null}

        <StickyActionBar
          secondary={
            <p className="text-xs text-ink-3">
              {placeError ? (
                <span className="text-danger">{placeError}</span>
              ) : (
                <>Quote valid for {Math.max(0, minutesRemaining)} minutes</>
              )}
            </p>
          }
        >
          <Button variant="primary" size="md" onClick={placedOrder?.paymentState === 'captured' ? undefined : placedOrder?.providerPaymentId ? handleCompletePayment : placedOrder ? handleStartPayment : handlePlaceOrder} loading={placing} disabled={placing || quote.quoteRequired}>
            {quote.quoteRequired ? 'Needs shop quote' : placedOrder?.paymentState === 'captured' ? 'Payment complete' : placedOrder?.providerPaymentId ? 'Complete payment' : placedOrder ? 'Start payment' : 'Place order'}
          </Button>
        </StickyActionBar>
      </div>
    )
  }

  // Fallback
  return (
    <div className="p-4">
      <p>Loading...</p>
      <button onClick={handleBackToUpload}>Back to upload</button>
    </div>
  )
}
