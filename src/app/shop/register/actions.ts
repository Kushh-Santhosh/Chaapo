'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { registerDevShop } from '@/server/domains/discovery'
import { encodeShopSession } from '@/server/http/shop-identity'

export async function registerShopAction(formData: FormData): Promise<void> {
  const name = String(formData.get('name') ?? '').trim()
  const email = String(formData.get('email') ?? '').trim()
  const phone = String(formData.get('phone') ?? '').trim()
  const addressLine1 = String(formData.get('addressLine1') ?? '').trim()
  const localityName = String(formData.get('localityName') ?? '').trim()
  const cityName = String(formData.get('cityName') ?? '').trim()
  const pincode = String(formData.get('pincode') ?? '').trim()
  const about = String(formData.get('about') ?? '').trim()
  const latitude = Number(formData.get('latitude'))
  const longitude = Number(formData.get('longitude'))

  if (!name || !email || !phone || !addressLine1 || !localityName || !cityName || !pincode || !about) {
    redirect('/shop/register?error=Complete+all+required+fields')
  }
  if (!/^\S+@\S+\.\S+$/.test(email) || !/^[0-9+ ()-]{8,20}$/.test(phone)) {
    redirect('/shop/register?error=Enter+a+valid+email+and+phone')
  }
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    redirect('/shop/register?error=Enter+valid+map+coordinates')
  }

  let shop
  try {
    shop = registerDevShop({
      ownerUserId: `shop-owner-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`,
      name,
      email,
      phone,
      addressLine1,
      localityName,
      cityName,
      pincode,
      latitude,
      longitude,
      about,
      capabilities: {
        paperSizes: ['a4'],
        colour: true,
        bw: true,
        duplex: true,
        finishings: ['spiral', 'lamination'],
        cardStock: false,
        photoPaper: false,
        largeFormat: false,
        scanning: true,
        printerCount: 1,
      },
    })

  } catch (error) {
    const message = error instanceof Error ? error.message : 'That shop could not be registered.'
    redirect(`/shop/register?error=${encodeURIComponent(message)}`)
  }

  const session = encodeShopSession({
    userId: shop.id,
    shopId: shop.id,
    role: 'shop_owner',
    label: shop.name,
  })
  ;(await cookies()).set('chaapo_shop_session', session, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 12,
  })
  redirect('/shop/orders')
}
