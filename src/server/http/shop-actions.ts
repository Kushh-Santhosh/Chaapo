'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { decodeShopSession, encodeShopSession } from './shop-identity'

export async function setShopSessionAction(formData: FormData): Promise<void> {
  const shopId = String(formData.get('shopId') ?? '')
  const userId = String(formData.get('userId') ?? '')
  const role = String(formData.get('role') ?? '')
  const label = String(formData.get('label') ?? '')

  const session = decodeShopSession(
    encodeShopSession({
      userId,
      shopId,
      role: role === 'shop_staff' ? 'shop_staff' : 'shop_owner',
      label,
    }),
  )

  if (!session) {
    redirect('/shop/login')
  }

  ;(await cookies()).set('chaapo_shop_session', encodeShopSession(session), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 12,
  })

  redirect('/shop/orders')
}

export async function clearShopSessionAction(): Promise<void> {
  const store = await cookies()
  store.delete('chaapo_shop_session')
  store.delete('__Host-chaapo_shop_session')
  redirect('/shop/login')
}
