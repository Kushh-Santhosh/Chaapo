import type { FieldError } from '../core/errors'

/**
 * Password policy, for the two surfaces that have passwords at all.
 *
 * Customers never see this: their credential is a phone number and an OTP. It is
 * shop owners, shop staff and admins who sign in with a password — which means
 * every password behind this module guards either a shop's money or the whole
 * platform's.
 *
 * The rules follow NIST SP 800-63B rather than the composition rules people expect:
 * a length floor, a blocklist, and nothing about uppercase or punctuation. Forcing a
 * symbol produces `Chaapo@2024` — which is in every cracking wordlist — while
 * forbidding a long passphrase for lacking a digit is a straight loss. What is
 * blocked instead is what actually gets guessed: the shop's own name, the owner's
 * phone number, and the few hundred passwords that appear in every dump.
 *
 * Validation happens here and only here. `hashPassword` in `core/crypto` throws
 * below the minimum length rather than accepting a weak password quietly, so this
 * module is what stands between a form and a 500.
 */

export const PASSWORD_POLICY = {
  /**
   * Ten. Matches `hashPassword`'s hard floor exactly — if these two ever disagree,
   * the shorter one turns a field error into an unhandled exception on a signup
   * form.
   */
  minLength: 10,
  /**
   * Bounded so a request body cannot become a CPU bill. Far above any real
   * passphrase; a person who wants 200 characters has other problems.
   */
  maxLength: 200,
  /**
   * `aaaaaaaaaa` and `1111111111` both clear a length floor. Five distinct
   * characters is the cheapest rule that removes them without touching anything a
   * person would actually choose.
   */
  minDistinctCharacters: 5,
} as const

/**
 * NFKC, and deliberately no trimming.
 *
 * `hashPassword` normalises the same way, so a password typed on a Hindi keyboard
 * and re-typed on an English one still verifies. Whitespace is left alone: a
 * trailing space is part of the password, and silently trimming it on the way in
 * means the string that was stored is not the string that was typed — which
 * surfaces later as "my password stopped working" from a person whose password
 * manager does not trim.
 */
export function normalisePassword(input: string): string {
  return input.normalize('NFKC')
}

/**
 * Passwords common enough that the attempt cap is the only thing between them and
 * an attacker — plus the ones this product invites specifically.
 *
 * Compared against the password's alphabetic core (see `isBlockedCore`), so
 * `Password@123` and `pa55word!!` both land on `password`. A real deployment syncs a
 * few hundred thousand of these from a breach corpus; this list is the floor, not
 * the ceiling.
 */
const BLOCKED_CORES = new Set([
  'password',
  'passwd',
  'pass',
  'welcome',
  'letmein',
  'qwerty',
  'qwertyuiop',
  'asdfgh',
  'asdfghjkl',
  'zxcvbnm',
  'iloveyou',
  'admin',
  'administrator',
  'root',
  'login',
  'secret',
  'changeme',
  'default',
  'abcdef',
  'abcdefgh',
  'abcd',
  'monkey',
  'dragon',
  'sunshine',
  'princess',
  'football',
  'cricket',
  'india',
  'bharat',
  'mumbai',
  'delhi',
  'bangalore',
  'chennai',
  'kolkata',
  'hyderabad',
  'ahmedabad',
  'pune',
  'jaipur',
  'ganesh',
  'ganpati',
  'krishna',
  'shiva',
  'sairam',
  'saibaba',
  'omsairam',
  'jaimatadi',
  'radhe',
  'radhakrishna',
  'namaste',
  'bhagwan',
  // The ones this product hands people.
  'chaapo',
  'chaapoprint',
  'print',
  'printshop',
  'printing',
  'xerox',
  'photocopy',
  'shop',
  'myshop',
  'stationery',
])

/**
 * Reduce a password to the word an attacker's wordlist would call it.
 *
 * Two reductions, because neither alone survives how people pad a base word.
 * Stripping every non-letter turns `password12` and `pass!!word` into `password`
 * but leaves `pa55word` alone. Folding leet substitutions catches `pa55word` but
 * then reads the trailing `!!` of `pa55word!!` as `ii`. So the padding is trimmed
 * off the ends first, the interior is folded, and both readings are checked.
 */
function isBlockedCore(password: string): boolean {
  const lower = password.toLowerCase()

  const stripped = lower.replace(/[^a-z]/g, '')
  if (BLOCKED_CORES.has(stripped)) return true

  const folded = lower
    .replace(/^[^a-z]+|[^a-z]+$/g, '')
    .replace(/[@4]/g, 'a')
    .replace(/3/g, 'e')
    .replace(/[!1|]/g, 'i')
    .replace(/0/g, 'o')
    .replace(/[$5]/g, 's')
    .replace(/7/g, 't')
    .replace(/[^a-z]/g, '')

  return BLOCKED_CORES.has(folded)
}

/** True when the password repeats one character or walks a keyboard run. */
function isTrivialSequence(password: string): boolean {
  const lower = password.toLowerCase()
  if (/^(.)\1*$/.test(lower)) return true

  const runs = ['abcdefghijklmnopqrstuvwxyz', '0123456789', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm']
  for (const run of runs) {
    if (run.includes(lower)) return true
    if ([...run].reverse().join('').includes(lower)) return true
  }
  return false
}

/** Digit runs of 4+ from the user's own details, which are the first thing tried. */
function ownDetailFragments(params: {
  phone?: string | null
  email?: string | null
  fullName?: string | null
  shopName?: string | null
}): string[] {
  const fragments: string[] = []

  const phoneDigits = (params.phone ?? '').replace(/\D/g, '')
  // The last ten are the number itself; the last four are what a person reaches for.
  if (phoneDigits.length >= 10) fragments.push(phoneDigits.slice(-10))
  if (phoneDigits.length >= 6) fragments.push(phoneDigits.slice(-6))

  const localPart = (params.email ?? '').split('@')[0] ?? ''
  if (localPart.length >= 4) fragments.push(localPart)

  for (const source of [params.fullName, params.shopName]) {
    for (const word of (source ?? '').split(/\s+/)) {
      if (word.length >= 4) fragments.push(word)
    }
  }

  return fragments.map((fragment) => fragment.toLowerCase()).filter((fragment) => fragment.length >= 4)
}

export interface PasswordContext {
  /** E.164, as stored. Used to reject a password containing the person's number. */
  phone?: string | null
  email?: string | null
  fullName?: string | null
  /** The shop the owner is signing up — the single most guessable choice. */
  shopName?: string | null
}

/**
 * Every problem with a password, as field errors ready to render under the input.
 *
 * Returns all of them rather than the first, because a form that reveals one rule
 * at a time is how people end up at `Chaapo@1` after four attempts.
 */
export function validatePassword(
  password: string,
  context: PasswordContext = {},
  confirm?: string,
): FieldError[] {
  const fields: FieldError[] = []
  // Measured on the normalised string, because that is what gets hashed. NFKC can
  // compose two code points into one, so a 10-character input can arrive at
  // `hashPassword` as 9 and throw there instead of failing politely here.
  const normalised = normalisePassword(password)

  if (normalised === '') {
    return [{ path: 'password', message: 'Choose a password.' }]
  }

  if (normalised.length < PASSWORD_POLICY.minLength) {
    fields.push({
      path: 'password',
      message: `Use at least ${PASSWORD_POLICY.minLength} characters. A short phrase you will remember beats a clever short word.`,
    })
  }

  if (normalised.length > PASSWORD_POLICY.maxLength) {
    fields.push({
      path: 'password',
      message: `That is longer than ${PASSWORD_POLICY.maxLength} characters.`,
    })
  }

  if (new Set(normalised).size < PASSWORD_POLICY.minDistinctCharacters || isTrivialSequence(normalised)) {
    fields.push({
      path: 'password',
      message: 'That is too repetitive to be a password. Try a few unrelated words instead.',
    })
  } else if (isBlockedCore(normalised)) {
    // `else if`, so a password that is both repetitive and common gets one message.
    fields.push({
      path: 'password',
      message: 'That password is one of the most commonly used ones. Pick something else.',
    })
  }

  const lower = normalised.toLowerCase()
  for (const fragment of ownDetailFragments(context)) {
    if (lower.includes(fragment)) {
      fields.push({
        path: 'password',
        message: 'Do not use your name, phone number, email or shop name in your password.',
      })
      break
    }
  }

  if (confirm !== undefined && normalisePassword(confirm) !== normalised) {
    fields.push({ path: 'confirm', message: 'Those two passwords do not match.' })
  }

  return fields
}

export function isPasswordAcceptable(password: string, context: PasswordContext = {}): boolean {
  return validatePassword(password, context).length === 0
}

export type PasswordStrength = 0 | 1 | 2 | 3 | 4
export type PasswordStrengthLabel = 'Too weak' | 'Weak' | 'Fair' | 'Good' | 'Strong'

export interface PasswordStrengthResult {
  score: PasswordStrength
  label: PasswordStrengthLabel
  /** One concrete thing that would improve it, or null when nothing needs saying. */
  hint: string | null
}

const STRENGTH_LABELS: Record<PasswordStrength, PasswordStrengthLabel> = {
  0: 'Too weak',
  1: 'Weak',
  2: 'Fair',
  3: 'Good',
  4: 'Strong',
}

/**
 * A meter for the signup form. Advisory only — `validatePassword` is the gate.
 *
 * Scored on length above all, because length is what actually costs an attacker
 * time, with a small credit for variety. A meter that rewards `P@ss1!` over
 * `orange harbour lamp` teaches the wrong thing, so this one does not.
 */
export function passwordStrength(password: string): PasswordStrengthResult {
  const normalised = normalisePassword(password)
  const length = normalised.length

  if (length === 0) return { score: 0, label: 'Too weak', hint: 'Choose a password.' }

  if (
    length < PASSWORD_POLICY.minLength ||
    isTrivialSequence(normalised) ||
    new Set(normalised).size < PASSWORD_POLICY.minDistinctCharacters
  ) {
    return {
      score: 0,
      label: 'Too weak',
      hint:
        length < PASSWORD_POLICY.minLength
          ? `${PASSWORD_POLICY.minLength - length} more character${length === PASSWORD_POLICY.minLength - 1 ? '' : 's'} to go.`
          : 'Too repetitive. Try a few unrelated words.',
    }
  }

  if (isBlockedCore(normalised)) {
    return { score: 0, label: 'Too weak', hint: 'That is a very commonly used password.' }
  }

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(normalised)).length
  const hasSpace = /\s/.test(normalised)

  let score = 1
  if (length >= 12) score += 1
  if (length >= 16) score += 1
  if (classes >= 3 || hasSpace) score += 1

  const capped = Math.min(score, 4) as PasswordStrength

  return {
    score: capped,
    label: STRENGTH_LABELS[capped],
    hint: capped >= 3 ? null : 'Longer is stronger — a few unrelated words works well.',
  }
}
