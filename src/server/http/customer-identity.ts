/**
 * Customer identity resolution for the app's current browser.
 *
 * The real auth layer does not exist yet, but the app still needs one stable value for
 * "who owns this customer's orders right now." The rule is deliberately simple:
 *   1) a signed-in customer session wins when one is present;
 *   2) otherwise the anonymous draft owner is used while the browser is still in the
 *      upload flow;
 *   3) if neither exists, the customer has no personal order surface to read.
 */

import { cookies } from 'next/headers'

import { readDraftOwnerId } from './draft-identity'
import type { AuthContext } from '@/server/core/rbac'

const CUSTOMER_SESSION_COOKIE = 'chaapo_customer_user_id'

export function resolveCustomerUserId(params: {
  customerSessionId: string | null
  draftOwnerId: string | null
}): string | null {
  if (params.customerSessionId && params.customerSessionId.trim()) return params.customerSessionId.trim()
  if (params.draftOwnerId && params.draftOwnerId.trim()) return params.draftOwnerId.trim()
  return null
}

export async function readCustomerSessionId(): Promise<string | null> {
  const store = await cookies()
  const value = store.get(CUSTOMER_SESSION_COOKIE)?.value
  if (!value || !value.trim()) return null
  return value.trim()
}

export async function readCustomerUserId(): Promise<string | null> {
  const customerSessionId = await readCustomerSessionId()
  const draftOwnerId = await readDraftOwnerId()
  return resolveCustomerUserId({ customerSessionId, draftOwnerId })
}

export function customerAuthContext(userId: string): AuthContext {
  return {
    actorType: 'customer',
    userId,
    role: 'customer',
    roles: ['customer'],
    shopIds: [],
    surface: 'customer',
    sessionId: null,
    mfaSatisfied: false,
    impersonatedUserId: null,
    label: null,
  }
}
