import { describe, expect, it } from 'vitest'

import {
  isPasswordAcceptable,
  normalisePassword,
  passwordStrength,
  validatePassword,
  PASSWORD_POLICY,
} from './password'

/**
 * Every password this module guards belongs to a shop owner, a staff member or an
 * admin — so it protects either one shop's takings or the whole platform's. The
 * tests are written around the guesses that actually happen: the shop's own name,
 * the owner's phone number, and the handful of passwords that appear in every dump.
 *
 * Combining characters are confined to the two constants below rather than sprinkled
 * through the cases. A decomposed `é` typed inline is invisible in a diff and gets
 * silently recomposed by editors and copy-paste, which would quietly turn the
 * normalisation tests into tautologies that pass no matter what the code does.
 */

const OWNER = {
  phone: '+919876543210',
  email: 'priya.sharma@gmail.com',
  fullName: 'Priya Sharma',
  shopName: 'Sharma Digital Prints',
}

/** `é` as one code point, and as `e` + a combining acute. */
const E_ACUTE_COMPOSED = 'é'
const E_ACUTE_DECOMPOSED = 'é'

function messages(result: ReturnType<typeof validatePassword>): string {
  return result.map((field) => `${field.path}: ${field.message}`).join(' | ')
}

describe('PASSWORD_POLICY', () => {
  it('never drops below the length hashPassword will accept', () => {
    // `hashPassword` throws below 10 rather than storing a weak hash. If this
    // constant ever went lower, a signup form would return a 500 instead of a field
    // error, and the two would have to be changed together.
    expect(PASSWORD_POLICY.minLength).toBeGreaterThanOrEqual(10)
  })
})

describe('normalisePassword', () => {
  it('normalises the way hashPassword does, so both keyboards work', () => {
    // Two keyboards, one password. If these hashed differently the person could
    // set a password on their phone and be locked out on their desktop.
    const composed: string = `caf${E_ACUTE_COMPOSED}-harbour`
    const decomposed: string = `caf${E_ACUTE_DECOMPOSED}-harbour`
    // Annotated `string` so the comparison survives typecheck: TypeScript can see the
    // two literal types are distinct and would otherwise flag a check that is the whole
    // premise of the test — these really are two different strings that must hash alike.
    expect(composed === decomposed).toBe(false)
    expect(normalisePassword(decomposed)).toBe(normalisePassword(composed))
  })

  it('does not trim, because whitespace is part of the password', () => {
    // Trimming means the string stored is not the string typed, which surfaces
    // later as "my password stopped working" on a client that does not trim.
    expect(normalisePassword('orange harbour lamp ')).toBe('orange harbour lamp ')
  })
})

describe('validatePassword', () => {
  it('accepts a passphrase without demanding a symbol', () => {
    // The point of following NIST here: length beats punctuation, and requiring a
    // symbol is what produces `Chaapo@2024`.
    for (const good of [
      'orange harbour lamp',
      'correct horse battery',
      'thengai-sadam-1998',
      'MySh0pOnBrigadeRd',
    ]) {
      expect(validatePassword(good, OWNER), good).toEqual([])
    }
  })

  it('rejects an empty password with one message, not five', () => {
    expect(validatePassword('', OWNER)).toEqual([{ path: 'password', message: 'Choose a password.' }])
  })

  it('rejects anything below the length floor', () => {
    const result = validatePassword('short1', OWNER)
    expect(result).toHaveLength(1)
    expect(result[0]?.path).toBe('password')
    expect(result[0]?.message).toContain('at least 10 characters')
  })

  it('measures length after normalisation, because that is what gets hashed', () => {
    // Ten code points that NFKC composes into nine. Accepting it here would hand
    // `hashPassword` a nine-character password and turn a field error into a 500.
    const tenBecomesNine = `${E_ACUTE_DECOMPOSED}zxkqbmrt`
    expect(tenBecomesNine.length).toBe(10)
    expect(normalisePassword(tenBecomesNine).length).toBe(9)
    expect(messages(validatePassword(tenBecomesNine))).toContain('at least 10 characters')
  })

  it('rejects a repeated character however long it is', () => {
    expect(messages(validatePassword('aaaaaaaaaaaaaaaa'))).toContain('too repetitive')
    expect(messages(validatePassword('1111111111'))).toContain('too repetitive')
  })

  it('rejects a keyboard walk, forwards and backwards', () => {
    for (const walk of ['qwertyuiop', 'abcdefghij', '0123456789', 'poiuytrewq', 'zyxwvutsrq']) {
      expect(messages(validatePassword(walk)), walk).toContain('too repetitive')
    }
  })

  it('rejects the common passwords, through the substitutions people make', () => {
    // `Password@123` and `pa55word!!` are the same password to anyone running a
    // wordlist, so both have to fail for the blocklist to be worth having.
    for (const common of ['password12', 'Password@123', 'pa55word!!', 'LetMeIn2024', 'iloveyou123']) {
      expect(messages(validatePassword(common)), common).toContain('commonly used')
    }
  })

  it('rejects the words this product puts in front of people', () => {
    for (const common of ['chaapo1234', 'PrintShop99', 'xerox12345', 'MyShop2024']) {
      expect(messages(validatePassword(common)), common).toContain('commonly used')
    }
  })

  it('gives one message when a password is both repetitive and common', () => {
    // Two messages for one problem reads as two problems.
    expect(validatePassword('aaaaaaaaaa')).toHaveLength(1)
  })

  it('rejects the owner’s own phone number', () => {
    // The first thing anyone tries against a shop dashboard.
    expect(messages(validatePassword('brigade9876543210road', OWNER))).toContain('phone number')
    expect(messages(validatePassword('brigade543210road', OWNER))).toContain('phone number')
  })

  it('rejects the owner’s own name, email and shop name', () => {
    for (const bad of ['priyasharma01', 'PriyaIsHere2024', 'priya.sharma@1', 'SharmaPrints24']) {
      expect(messages(validatePassword(bad, OWNER)), bad).toContain('shop name')
    }
  })

  it('only checks the details it was given', () => {
    // On a password-reset screen we may hold nothing but the password.
    expect(validatePassword('priyasharma01')).toEqual([])
  })

  it('ignores fragments too short to mean anything', () => {
    // Three letters inside a passphrase is a coincidence, not a weakness. Matching
    // on them would fail `orange harbour lamp` for a shop called "Om".
    expect(validatePassword('orange harbour lamp', { fullName: 'Om Ram', shopName: 'Om' })).toEqual([])
  })

  it('reports every problem at once', () => {
    // A form that reveals one rule at a time is how people arrive at `Chaapo@1`.
    const result = validatePassword('priya123', OWNER, 'different')
    expect(result.length).toBeGreaterThanOrEqual(2)
    expect(result.some((field) => field.path === 'confirm')).toBe(true)
  })

  it('checks the confirmation only when one was given', () => {
    expect(validatePassword('orange harbour lamp', OWNER)).toEqual([])
    expect(validatePassword('orange harbour lamp', OWNER, 'orange harbour lamp')).toEqual([])
    expect(validatePassword('orange harbour lamp', OWNER, 'orange harbour lam')).toEqual([
      { path: 'confirm', message: 'Those two passwords do not match.' },
    ])
  })

  it('compares the confirmation after normalisation', () => {
    // Two keyboards again. Failing this asks the person to retype a password that
    // is already correct.
    expect(
      validatePassword(`caf${E_ACUTE_COMPOSED}-harbour`, {}, `caf${E_ACUTE_DECOMPOSED}-harbour`),
    ).toEqual([])
  })

  it('rejects a password past the upper bound', () => {
    expect(messages(validatePassword('a1b2c3d4e5'.repeat(21)))).toContain('longer than 200')
  })

  it('accepts a long passphrase inside the bound', () => {
    expect(validatePassword('a1b2c3d4e5'.repeat(20))).toEqual([])
  })
})

describe('isPasswordAcceptable', () => {
  it('agrees with validatePassword', () => {
    expect(isPasswordAcceptable('orange harbour lamp', OWNER)).toBe(true)
    expect(isPasswordAcceptable('password12', OWNER)).toBe(false)
  })
})

describe('passwordStrength', () => {
  it('rewards length over punctuation', () => {
    // A meter that scores `P@ss1!` above `orange harbour lamp` teaches the wrong
    // lesson, so this one must not.
    expect(passwordStrength('orange harbour lamp').score).toBeGreaterThan(
      passwordStrength('P@ss1!').score,
    )
  })

  it('scores anything the policy rejects as zero', () => {
    for (const bad of ['', 'short', 'aaaaaaaaaa', 'password12', 'qwertyuiop']) {
      expect(passwordStrength(bad).score, bad).toBe(0)
    }
  })

  it('counts down the characters still needed', () => {
    expect(passwordStrength('zxkqbm').hint).toBe('4 more characters to go.')
    expect(passwordStrength('zxkqbmrtv').hint).toBe('1 more character to go.')
  })

  it('climbs with length and stops at four', () => {
    const scores = ['zxkqbmrtvw', 'zxkqbmrtvwpn', 'zxkqbmrtvwpnhgdf', 'zxkqbmrtvwpnhgdf!A9'].map(
      (password) => passwordStrength(password).score,
    )
    expect(scores).toEqual([1, 2, 3, 4])
    expect(passwordStrength('zxkqbmrtvwpnhgdflsjeucyi!A9').score).toBe(4)
  })

  it('stops nagging once a password is good', () => {
    expect(passwordStrength('orange harbour lamp').hint).toBeNull()
    expect(passwordStrength('zxkqbmrtvw').hint).not.toBeNull()
  })

  it('labels every score', () => {
    const labels = ['zxkqbmrtvw', 'zxkqbmrtvwpn', 'zxkqbmrtvwpnhgdf', 'orange harbour lamp'].map(
      (password) => passwordStrength(password).label,
    )
    expect(labels).toEqual(['Weak', 'Fair', 'Good', 'Strong'])
  })
})
