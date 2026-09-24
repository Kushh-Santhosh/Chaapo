/**
 * Shop identity helpers.
 *
 * This is the small development seam that lets the app exercise the actual shop-side
 * authorization path without a database-backed auth layer. The session carries the
 * same data the production auth stack would: user id, role, shop scope, and a shop
 * label. The RBAC guard still resolves the capability from the real matrix and the
 * real shopId on the order.
 */

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { type AuthContext, requireCapability } from '@/server/core/rbac'
import { getShopOrder } from '@/server/domains/orders/service'

export type ShopRole = 'shop_owner' | 'shop_staff'

export interface ShopSession {
  userId: string
  shopId: string
  role: ShopRole
  label: string
}

const SHOP_SESSION_COOKIE = 'chaapo_shop_session'

export function encodeShopSession(session: ShopSession): string {
  return Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')
}

export function decodeShopSession(raw: string | undefined): ShopSession | null {
  if (!raw || !raw.trim()) return null

  try {
    const text = Buffer.from(raw, 'base64url').toString('utf8')
    const parsed = JSON.parse(text) as Partial<ShopSession>
    if (!parsed.userId || !parsed.shopId || !parsed.role || !parsed.label) return null
    if (parsed.role !== 'shop_owner' && parsed.role !== 'shop_staff') return null
    return {
      userId: String(parsed.userId),
      shopId: String(parsed.shopId),
      role: parsed.role,
      label: String(parsed.label),
    }
  } catch {
    return null
  }
}

export async function readShopSession(): Promise<ShopSession | null> {
  const store = await cookies()
  const raw = store.get(SHOP_SESSION_COOKIE)?.value ?? store.get('__Host-chaapo_shop_session')?.value
  return decodeShopSession(raw)
}

export async function requireShopSession(): Promise<ShopSession> {
  const session = await readShopSession()
  if (!session) redirect('/shop/login')
  return session
}

export function shopAuthContext(session: ShopSession): AuthContext {
  return {
    actorType: 'shop',
    userId: session.userId,
    role: session.role,
    roles: [session.role],
    shopIds: [session.shopId],
    surface: 'shop',
    sessionId: 'dev-shop-session',
    mfaSatisfied: false,
    impersonatedUserId: null,
    label: session.label,
  }
}

export async function requireShopOrderAccess(
  session: ShopSession,
  orderId: string,
): Promise<{ order: Awaited<ReturnType<typeof getShopOrder>>; actor: AuthContext }> {
  const actor = shopAuthContext(session)
  const order = await getShopOrder(session.shopId, orderId)
  if (!order) {
    const grant = requireCapability(actor, 'order.view_shop', { shopId: session.shopId })
    if (!grant.ok) {
      throw new Error('shop access denied')
    }
    throw new Error('order-not-found')
  }

  const grant = requireCapability(actor, 'order.view_shop', { shopId: order.shopId })
  if (!grant.ok) {
    throw new Error('shop access denied')
  }

  return { order, actor }
}
