import { describe, expect, it } from 'vitest'

import {
  COUNTRY_PREFIX,
  describePhoneProblem,
  formatPhone,
  isMobile,
  normaliseMobile,
  normalisePhone,
  phoneKind,
  phoneLast4,
} from './phone'

/**
 * These tests are really about one invariant: **one person, one hash**.
 *
 * `users.phone_hash` is a unique index over an HMAC of whatever this module
 * returns. If two spellings of the same number normalise differently, the second
 * sign-in creates a second account — and that customer's order history, saved
 * addresses and wallet-less refund trail silently fork. There is no error message
 * for that failure; it just quietly happens. So every spelling a person might
 * plausibly type is pinned here.
 */

/** The same Pune mobile number, spelled the way real people spell it. */
const SAME_NUMBER = [
  '9876543210',
  '98765 43210',
  '98765-43210',
  '987-654-3210',
  '09876543210',
  '0 98765 43210',
  '919876543210',
  '91 98765 43210',
  '+919876543210',
  '+91 98765 43210',
  '+91-98765-43210',
  '+91 (98765) 43210',
  '0091 98765 43210',
  '+910 98765 43210',
  '  +91 98765 43210  ',
]

describe('normalisePhone', () => {
  it('maps every spelling of one number onto one canonical value', () => {
    const normalised = new Set(SAME_NUMBER.map((input) => normalisePhone(input)))
    expect([...normalised]).toEqual(['+919876543210'])
  })

  it('produces E.164, which is what the SMS provider and the blind index both want', () => {
    const value = normalisePhone('98765 43210') as string
    expect(value.startsWith(COUNTRY_PREFIX)).toBe(true)
    expect(value).toMatch(/^\+91\d{10}$/)
  })

  it('accepts Indic digits, because that is what a Hindi keyboard produces', () => {
    expect(normalisePhone('९८७६५४३२१०')).toBe('+919876543210')
    expect(normalisePhone('+९१ ९८७६५ ४३२१०')).toBe('+919876543210')
    // Tamil, Bengali, Gujarati, Gurmukhi, Kannada, Malayalam, Telugu.
    expect(normalisePhone('௯௮௭௬௫௪௩௨௧௦')).toBe('+919876543210')
    expect(normalisePhone('৯৮৭৬৫৪৩২১০')).toBe('+919876543210')
    expect(normalisePhone('૯૮૭૬૫૪૩૨૧૦')).toBe('+919876543210')
    expect(normalisePhone('੯੮੭੬੫੪੩੨੧੦')).toBe('+919876543210')
    expect(normalisePhone('೯೮೭೬೫೪೩೨೧೦')).toBe('+919876543210')
    expect(normalisePhone('൯൮൭൬൫൪൩൨൧൦')).toBe('+919876543210')
    expect(normalisePhone('౯౮౭౬౫౪౩౨౧౦')).toBe('+919876543210')
  })

  it('rejects what is not an Indian number', () => {
    for (const input of [
      '',
      '   ',
      '98765',
      '987654321',
      '98765432101',
      '+1 415 555 0100',
      '+44 20 7946 0958',
      '+971 50 123 4567',
      'nine eight seven',
      '98765abcde',
      '+',
      '0000000000',
      '0912345678',
    ]) {
      expect(normalisePhone(input), JSON.stringify(input)).toBeNull()
    }
  })

  it('does not treat a leading 91 inside a landline as a country code', () => {
    // 022 9155 1234 is a ten-digit Mumbai landline that begins 22, not 91. The
    // bug this guards against is stripping "91" from a number that merely
    // contains it, which would silently produce an eight-digit stub.
    expect(normalisePhone('022 9155 1234')).toBe('+912291551234')
    expect(normalisePhone('9155123456')).toBe('+919155123456')
  })
})

describe('phoneKind', () => {
  it('calls 6–9 a mobile', () => {
    for (const first of ['6', '7', '8', '9']) {
      expect(phoneKind(`${first}876543210`), first).toBe('mobile')
    }
  })

  it('calls an area code beginning 1–5 a landline', () => {
    // Delhi 011, Mumbai 022, Pune 020, Kolkata 033, Hyderabad 040, Chennai 044.
    expect(phoneKind('+911123456789')).toBe('landline')
    expect(phoneKind('+912223456789')).toBe('landline')
    expect(phoneKind('+912026123456')).toBe('landline')
    expect(phoneKind('+913323456789')).toBe('landline')
    expect(phoneKind('+914023456789')).toBe('landline')
    expect(phoneKind('+914423456789')).toBe('landline')
  })

  it('resolves the 079/080 overlap in favour of mobile, on purpose', () => {
    // Ahmedabad (079) and Bangalore (080) landlines are indistinguishable from
    // mobiles in the 79xxx and 80xxx series, both of which are really allocated.
    // We accept the landline rather than reject the mobile: a wasted OTP beats
    // telling a real customer their own number is invalid. Delivery failure is
    // the backstop, and the resend flow already exists for it.
    expect(phoneKind('+918023456789')).toBe('mobile')
    expect(phoneKind('+917926123456')).toBe('mobile')
    expect(normaliseMobile('080 2345 6789')).toBe('+918023456789')
  })

  it('returns null for a non-number', () => {
    expect(phoneKind('not a number')).toBeNull()
  })
})

describe('normaliseMobile', () => {
  it('is what a credential goes through', () => {
    expect(normaliseMobile('98765 43210')).toBe('+919876543210')
    expect(isMobile('98765 43210')).toBe(true)
  })

  it('refuses a landline, because an OTP cannot reach it', () => {
    // A shop's *published* contact number may be a landline. The number a person
    // signs in with may not, and the difference has to be enforced before an SMS
    // is paid for and lost.
    expect(normalisePhone('020 2612 3456')).toBe('+912026123456')
    expect(normaliseMobile('020 2612 3456')).toBeNull()
    expect(isMobile('020 2612 3456')).toBe(false)
  })
})

describe('formatPhone', () => {
  it('groups the way an Indian number is read aloud', () => {
    expect(formatPhone('+919876543210')).toBe('+91 98765 43210')
    expect(formatPhone('9876543210')).toBe('+91 98765 43210')
  })

  it('returns the input untouched when it cannot parse it', () => {
    // Display code must never blank out a value it does not understand.
    expect(formatPhone('not a number')).toBe('not a number')
  })
})

describe('phoneLast4', () => {
  it('gives the customer enough to recognise their own number', () => {
    // "We sent a code to the number ending 3210" — recognisable to its owner,
    // useless to anyone reading over a shoulder or reading a support ticket.
    expect(phoneLast4('+91 98765 43210')).toBe('3210')
  })

  it('returns null rather than a partial guess', () => {
    expect(phoneLast4('98765')).toBeNull()
  })
})

describe('describePhoneProblem', () => {
  it('says nothing when the number is fine', () => {
    expect(describePhoneProblem('98765 43210')).toBeNull()
    expect(describePhoneProblem('+91 98765 43210')).toBeNull()
  })

  it('asks for a number when the field is empty', () => {
    expect(describePhoneProblem('')).toBe('Enter your mobile number.')
    expect(describePhoneProblem('   ')).toBe('Enter your mobile number.')
  })

  it('distinguishes too short from unrecognisable', () => {
    expect(describePhoneProblem('98765')).toContain('too short')
    expect(describePhoneProblem('98765abcde')).not.toContain('too short')
  })

  it('explains the country limit instead of saying the number is wrong', () => {
    // A number that is valid in London is not "invalid"; it is out of scope, and
    // saying so is the difference between a user trying again and giving up.
    expect(describePhoneProblem('+44 20 7946 0958')).toContain('Indian mobile numbers only')
    expect(describePhoneProblem('+1 415 555 0100')).toContain('Indian mobile numbers only')
  })

  it('explains that a landline cannot receive the code', () => {
    expect(describePhoneProblem('020 2612 3456')).toContain('landline')
  })

  it('writes every message in product voice', () => {
    const messages = [
      describePhoneProblem(''),
      describePhoneProblem('98765'),
      describePhoneProblem('98765abcde'),
      describePhoneProblem('+44 20 7946 0958'),
      describePhoneProblem('020 2612 3456'),
      describePhoneProblem('9876543210987654'),
    ].filter((message): message is string => message !== null)

    expect(messages).toHaveLength(6)
    for (const message of messages) {
      expect(message, message).toMatch(/^[A-Z]/)
      expect(message, message).toMatch(/[.!?]$/)
      expect(message, message).not.toMatch(/_/)
    }
  })
})
