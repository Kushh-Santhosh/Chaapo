import type { Metadata } from 'next'
import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { registerShopAction } from './actions'

export const metadata: Metadata = {
  title: 'Register your shop',
  robots: { index: false, follow: false },
}

export default async function ShopRegisterPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>
}) {
  const error = (await searchParams)?.error

  return (
    <div className="mx-auto max-w-3xl">
      <Card variant="clay" padding="lg">
        <CardHeader
          eyebrow="Partner with Chaapo"
          title="Register your print shop"
          description="Add your real shop details so customers can find you, send jobs, and see what you offer."
        />
        {error ? <p className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null}
        <form action={registerShopAction} className="mt-6 grid gap-4 sm:grid-cols-2">
          <label className="space-y-1 text-sm font-medium text-ink">Shop name<input required name="name" className="field" /></label>
          <label className="space-y-1 text-sm font-medium text-ink">Owner email<input required type="email" name="email" className="field" /></label>
          <label className="space-y-1 text-sm font-medium text-ink">Phone<input required name="phone" className="field" /></label>
          <label className="space-y-1 text-sm font-medium text-ink">Address<input required name="addressLine1" className="field" /></label>
          <label className="space-y-1 text-sm font-medium text-ink">Locality<input required name="localityName" className="field" /></label>
          <label className="space-y-1 text-sm font-medium text-ink">City<input required name="cityName" defaultValue="Pune" className="field" /></label>
          <label className="space-y-1 text-sm font-medium text-ink">Pincode<input required name="pincode" inputMode="numeric" className="field" /></label>
          <label className="space-y-1 text-sm font-medium text-ink">Latitude<input required name="latitude" type="number" step="any" defaultValue="18.5204" className="field" /></label>
          <label className="space-y-1 text-sm font-medium text-ink">Longitude<input required name="longitude" type="number" step="any" defaultValue="73.8567" className="field" /></label>
          <label className="space-y-1 text-sm font-medium text-ink sm:col-span-2">About your shop<textarea required name="about" rows={3} className="field" /></label>
          <div className="sm:col-span-2 rounded-lg border border-rule bg-paper-sunk p-3 text-sm text-ink-3">Services included: B&W, colour, duplex, A4 printing, scanning, spiral binding, and lamination.</div>
          <div className="flex items-center justify-between gap-3 sm:col-span-2">
            <Link href="/shop/login" className="text-sm text-chaap underline">Back to shop login</Link>
            <Button type="submit" variant="primary">Create shop</Button>
          </div>
        </form>
      </Card>
    </div>
  )
}
