import { describe, expect, it } from 'vitest'

import { resolveCustomerUserId } from './customer-identity'

describe('resolveCustomerUserId', () => {
  it('prefers a signed-in customer session over the anonymous draft owner', () => {
    expect(resolveCustomerUserId({ customerSessionId: 'session-123', draftOwnerId: 'draft-456' })).toBe('session-123')
  })

  it('falls back to the anonymous draft owner when the customer is not signed in', () => {
    expect(resolveCustomerUserId({ customerSessionId: null, draftOwnerId: 'draft-456' })).toBe('draft-456')
  })

  it('returns null when neither identity exists', () => {
    expect(resolveCustomerUserId({ customerSessionId: null, draftOwnerId: null })).toBeNull()
  })
})
