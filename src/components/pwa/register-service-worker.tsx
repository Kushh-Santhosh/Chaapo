'use client'

/**
 * Registers the service worker.
 *
 * A component rather than an inline script so the CSP nonce is not needed, and
 * registration is deferred to `load` so it never competes with the first paint.
 * Registration is skipped in development: an aggressive shell cache is the classic
 * way to spend an afternoon debugging a change that did ship.
 */

import { useEffect } from 'react'

export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (!('serviceWorker' in navigator)) return

    const register = () => {
      void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        // A failed registration is not worth a message: the app works without it.
      })
    }

    if (document.readyState === 'complete') register()
    else window.addEventListener('load', register, { once: true })

    return () => window.removeEventListener('load', register)
  }, [])

  return null
}
