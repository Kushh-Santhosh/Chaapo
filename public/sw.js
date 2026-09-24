/**
 * Chaapo service worker.
 *
 * Deliberately small, and deliberately *not* an offline-first cache. Two rules
 * decide everything here:
 *
 *   1. Nothing private is ever stored. No `/api/**`, no file streams, no signed
 *      URLs, no order data. A shared phone must not leak the last customer's
 *      documents out of a cache (NFR-12).
 *   2. Only build assets and the offline page are cached, so a flaky 4G
 *      connection cannot leave the app looking broken while a shop is open.
 *
 * Anything more ambitious — background upload retry, push handling — arrives with
 * the domains that need it, not before.
 */

const VERSION = 'chaapo-v1'
const SHELL = `${VERSION}-shell`
const OFFLINE_URL = '/offline'

const PRECACHE = [OFFLINE_URL, '/brand/icon.svg', '/manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // Individually, so one 404 during a deploy does not fail the whole install.
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

/** Build output only. Hashed filenames, so a plain cache-first is safe. */
function isImmutableAsset(url) {
  return url.origin === self.location.origin && url.pathname.startsWith('/_next/static/')
}

function isPrivate(url) {
  return (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/files/') ||
    url.searchParams.has('X-Amz-Signature') ||
    url.searchParams.has('token')
  )
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (isPrivate(url)) return // straight to the network, never stored

  if (isImmutableAsset(url)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone()
              caches.open(SHELL).then((cache) => cache.put(request, copy))
            }
            return response
          }),
      ),
    )
    return
  }

  // Navigations: network first, offline page as the fallback. Never serve a
  // cached page — a stale order status is worse than an honest "you're offline".
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL).then((hit) => hit ?? Response.error())),
    )
  }
})
