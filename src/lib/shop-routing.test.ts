import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('shop routing structure', () => {
  it('keeps shop pages under an actual /shop URL segment and preserves customer routes', () => {
    const appRoot = join(process.cwd(), 'src/app')

    expect(existsSync(join(appRoot, 'shop', '(shop)', 'login', 'page.tsx'))).toBe(true)
    expect(existsSync(join(appRoot, 'shop', '(shop)', 'orders', 'page.tsx'))).toBe(true)
    expect(existsSync(join(appRoot, 'shop', '(shop)', 'orders', '[orderId]', 'page.tsx'))).toBe(true)

    expect(existsSync(join(appRoot, '(shop)', 'login', 'page.tsx'))).toBe(false)
    expect(existsSync(join(appRoot, '(shop)', 'orders', 'page.tsx'))).toBe(false)
    expect(existsSync(join(appRoot, '(shop)', 'orders', '[orderId]', 'page.tsx'))).toBe(false)

    expect(existsSync(join(appRoot, 'shop', 'login', 'page.tsx'))).toBe(false)
    expect(existsSync(join(appRoot, 'shop', 'orders', 'page.tsx'))).toBe(false)
    expect(existsSync(join(appRoot, 'shop', 'orders', '[orderId]', 'page.tsx'))).toBe(false)

    expect(existsSync(join(appRoot, '(customer)', 'orders', 'page.tsx'))).toBe(true)
    expect(existsSync(join(appRoot, '(customer)', 'orders', '[orderId]', 'page.tsx'))).toBe(true)
  })
})
