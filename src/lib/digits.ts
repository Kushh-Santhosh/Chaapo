/**
 * Digits.
 *
 * Indian users type on Indian keyboards, and a number pasted out of WhatsApp on a
 * phone set to Hindi or Tamil arrives as ९८७६५४३२१० rather than 9876543210. Every
 * place we read a number from a human — phone numbers, OTPs, pickup codes — has to
 * fold those to ASCII first, or we reject a correct answer and tell the user it is
 * wrong.
 */

/**
 * Zero of each Indic digit block we accept. Every block runs 0–9 contiguously from
 * its own base, so subtracting the base gives the value.
 */
const INDIC_DIGIT_BASES = [
  0x0966, // Devanagari — Hindi, Marathi, Nepali
  0x09e6, // Bengali — Bengali, Assamese
  0x0a66, // Gurmukhi — Punjabi
  0x0ae6, // Gujarati
  0x0b66, // Oriya
  0x0be6, // Tamil
  0x0c66, // Telugu
  0x0ce6, // Kannada
  0x0d66, // Malayalam
]

const INDIC_DIGIT_PATTERN = /[०-९০-৯੦-੯૦-૯୦-୯௦-௯౦-౯೦-೯൦-൯]/g

/** Rewrite Indic digits as ASCII, leaving everything else untouched. */
export function toAsciiDigits(input: string): string {
  return input.replace(INDIC_DIGIT_PATTERN, (char) => {
    const code = char.codePointAt(0)
    if (code === undefined) return char
    for (const base of INDIC_DIGIT_BASES) {
      if (code >= base && code <= base + 9) return String(code - base)
    }
    return char
  })
}

/** ASCII-fold, then keep only the digits. */
export function onlyDigits(input: string): string {
  return toAsciiDigits(input).replace(/\D/g, '')
}
