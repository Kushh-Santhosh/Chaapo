import { describe, expect, it } from 'vitest'

import { decodeShopSession, encodeShopSession, shopAuthContext } from './shop-identity'

describe('shop identity', () => {
  it('encodes and decodes a shop session preserving user and shop scope', () => {
    const encoded = encodeShopSession({
      userId: 'shop-user-9',
      shopId: 'shop-1',
      role: 'shop_owner',
      label: 'Shivaji Xerox',
    })

    expect(decodeShopSession(encoded)).toEqual({
      userId: 'shop-user-9',
      shopId: 'shop-1',
      role: 'shop_owner',
      label: 'Shivaji Xerox',
    })
  })

  it('builds a shop auth context that matches the RBAC shop surface', () => {
    const actor = shopAuthContext({
      userId: 'shop-user-9',
      shopId: 'shop-1',
      role: 'shop_owner',
      label: 'Shivaji Xerox',
    })

    expect(actor.surface).toBe('shop')
    expect(actor.role).toBe('shop_owner')
    expect(actor.shopIds).toEqual(['shop-1'])
  })
})
