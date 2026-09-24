'use client'

/**
 * Error boundary for the customer surface.
 *
 * `digest` is the only identifier React gives the client, and it is the same value
 * that appears in the server log — so it is shown as a reference someone can read
 * out to support. The message itself is never shown: it can carry a query, a table
 * name or a provider response, none of which is a customer's business (NFR-14).
 */

import { useEffect } from 'react'

import { ErrorState } from '@/components/ui/states'

export default function CustomerError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // The server already logged this; this is for the browser console during dev.
    if (process.env.NODE_ENV !== 'production') console.error(error)
  }, [error])

  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <ErrorState
        title="This screen did not load"
        description="Something failed on our side, not on your connection. Try again — nothing you had entered has been sent anywhere."
        onRetry={reset}
        {...(error.digest ? { correlationId: error.digest } : {})}
      />
    </div>
  )
}
