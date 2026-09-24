import type { Metadata } from 'next'
import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { DEV_SHOPS } from '@/server/domains/discovery/fixtures'
import { setShopSessionAction } from '@/server/http/shop-actions'

export const metadata: Metadata = {
  title: 'Shop login',
  robots: { index: false, follow: false },
}

export default async function ShopLoginPage() {
  const shops = DEV_SHOPS.slice(0, 3)

  return (
    <div className="mx-auto max-w-3xl">
      <Card variant="clay" padding="lg">
        <CardHeader
          eyebrow="Shop sign in"
          title="Choose a shop to manage"
          description="This is the local development sign-in seam for the real shop dashboard. It uses the same shop-scoped identity model the app expects in production."
        />

        <div className="mt-6 grid gap-3 md:grid-cols-2">
          {shops.map((shop) => (
            <form key={shop.id} action={setShopSessionAction} className="contents">
              <input type="hidden" name="shopId" value={shop.id} />
              <input type="hidden" name="userId" value={`shop-owner-${shop.id}`} />
              <input type="hidden" name="role" value="shop_owner" />
              <input type="hidden" name="label" value={shop.name} />
              <Card className="flex h-full flex-col justify-between gap-3 p-4">
                <div>
                  <p className="eyebrow">Shop</p>
                  <h3 className="mt-2 text-lg font-semibold text-ink">{shop.name}</h3>
                  <p className="mt-1 text-sm text-ink-3">
                    {shop.localityName}, {shop.cityName}
                  </p>
                </div>
                <Button type="submit" variant="primary" className="w-full">
                  Open queue
                </Button>
              </Card>
            </form>
          ))}
        </div>

        <div className="mt-6">
          <Link href="/" className="text-sm text-chaap underline decoration-chaap-edge underline-offset-3">
            Back to customer view
          </Link>
        </div>
        <div className="mt-3">
          <Link href="/shop/register" className="text-sm text-chaap underline decoration-chaap-edge underline-offset-3">
            Register a new shop
          </Link>
        </div>
      </Card>
    </div>
  )
}
