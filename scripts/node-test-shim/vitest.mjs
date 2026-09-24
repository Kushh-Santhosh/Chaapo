/**
 * A `vitest` stand-in built on `node:test`, so the real test files can run with nothing
 * installed.
 *
 * Why this exists: this environment cannot reach the npm registry, so `vitest` is not
 * installable here. Rather than leave the suite unrun until it is, this module exposes
 * the slice of vitest's API the project's tests actually use, backed by `node:test` and
 * `node:assert`. The test files import `'vitest'` exactly as they always did — nothing
 * in `src` knows this file exists, and CI still runs real vitest.
 *
 * It is a shim, not a reimplementation. It has no mocking, no snapshots, no coverage,
 * no `vi.*`. If a test needs any of those, it will fail loudly here and must be run
 * under real vitest instead of being bent to fit.
 */

import assert from 'node:assert/strict'
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'

const isObject = (value) => typeof value === 'object' && value !== null

/** Deep equality that treats bigint and number as distinct, like vitest's toEqual. */
function deepEqual(actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected)
    return true
  } catch {
    return false
  }
}

function describeValue(value) {
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'string') return JSON.stringify(value)
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `${v}n` : v))
  } catch {
    return String(value)
  }
}

function fail(message) {
  throw new assert.AssertionError({ message })
}

function matchesText(haystack, expected) {
  if (expected instanceof RegExp) return expected.test(haystack)
  return haystack.includes(expected)
}

function callAndCatch(fn) {
  if (typeof fn !== 'function') fail('expect(...).toThrow() requires a function')
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

/**
 * The matcher set, written once and mounted twice: on `expect(x)` and, with every
 * outcome inverted, on `expect(x).not`. Keeping one table is what stops `.not.toContain`
 * from drifting away from `toContain`.
 */
const MATCHERS = {
  toBe: (actual, expected) => ({
    pass: Object.is(actual, expected),
    message: `expected ${describeValue(actual)} to be ${describeValue(expected)}`,
  }),
  toEqual: (actual, expected) => ({
    pass: deepEqual(actual, expected),
    message: `expected ${describeValue(actual)} to equal ${describeValue(expected)}`,
  }),
  toStrictEqual: (actual, expected) => ({
    pass: deepEqual(actual, expected),
    message: `expected ${describeValue(actual)} to strictly equal ${describeValue(expected)}`,
  }),
  toBeNull: (actual) => ({
    pass: actual === null,
    message: `expected ${describeValue(actual)} to be null`,
  }),
  toBeUndefined: (actual) => ({
    pass: actual === undefined,
    message: `expected ${describeValue(actual)} to be undefined`,
  }),
  toBeDefined: (actual) => ({
    pass: actual !== undefined,
    message: `expected value to be defined`,
  }),
  toBeTruthy: (actual) => ({
    pass: Boolean(actual),
    message: `expected ${describeValue(actual)} to be truthy`,
  }),
  toBeFalsy: (actual) => ({
    pass: !actual,
    message: `expected ${describeValue(actual)} to be falsy`,
  }),
  toBeGreaterThan: (actual, expected) => ({
    pass: actual > expected,
    message: `expected ${describeValue(actual)} > ${describeValue(expected)}`,
  }),
  toBeGreaterThanOrEqual: (actual, expected) => ({
    pass: actual >= expected,
    message: `expected ${describeValue(actual)} >= ${describeValue(expected)}`,
  }),
  toBeLessThan: (actual, expected) => ({
    pass: actual < expected,
    message: `expected ${describeValue(actual)} < ${describeValue(expected)}`,
  }),
  toBeLessThanOrEqual: (actual, expected) => ({
    pass: actual <= expected,
    message: `expected ${describeValue(actual)} <= ${describeValue(expected)}`,
  }),
  toBeCloseTo: (actual, expected, digits = 2) => ({
    pass: Math.abs(actual - expected) < Math.pow(10, -digits) / 2,
    message: `expected ${describeValue(actual)} to be close to ${describeValue(expected)}`,
  }),
  toHaveLength: (actual, expected) => ({
    pass: actual != null && actual.length === expected,
    message: `expected length ${actual == null ? '<none>' : actual.length} to be ${expected}`,
  }),
  toHaveProperty: (actual, key, ...rest) => {
    const path = String(key).split('.')
    let cursor = actual
    for (const segment of path) {
      if (!isObject(cursor) || !(segment in cursor)) {
        return { pass: false, message: `expected object to have property ${String(key)}` }
      }
      cursor = cursor[segment]
    }
    if (rest.length === 0) return { pass: true, message: `expected no property ${String(key)}` }
    return {
      pass: deepEqual(cursor, rest[0]),
      message: `expected ${String(key)} to equal ${describeValue(rest[0])}, got ${describeValue(cursor)}`,
    }
  },
  /** Substring for strings, membership for arrays — the two vitest behaviours. */
  toContain: (actual, expected) => {
    if (typeof actual === 'string') {
      return {
        pass: actual.includes(expected),
        message: `expected ${describeValue(actual)} to contain ${describeValue(expected)}`,
      }
    }
    if (!Array.isArray(actual)) fail(`toContain() needs a string or array, got ${typeof actual}`)
    return {
      pass: actual.includes(expected),
      message: `expected array to contain ${describeValue(expected)}`,
    }
  },
  toContainEqual: (actual, expected) => {
    if (!Array.isArray(actual)) fail(`toContainEqual() needs an array, got ${typeof actual}`)
    return {
      pass: actual.some((entry) => deepEqual(entry, expected)),
      message: `expected array to contain an entry equal to ${describeValue(expected)}`,
    }
  },
  toMatch: (actual, expected) => {
    if (typeof actual !== 'string') fail(`toMatch() needs a string, got ${typeof actual}`)
    return {
      pass: matchesText(actual, expected),
      message: `expected ${describeValue(actual)} to match ${String(expected)}`,
    }
  },
  /** A recursive subset check: every key in `expected` must match, extras are ignored. */
  toMatchObject: (actual, expected) => {
    const walk = (a, e) => {
      if (!isObject(e)) return deepEqual(a, e)
      if (!isObject(a)) return false
      if (Array.isArray(e)) {
        if (!Array.isArray(a) || a.length !== e.length) return false
        return e.every((entry, index) => walk(a[index], entry))
      }
      return Object.keys(e).every((key) => walk(a[key], e[key]))
    }
    return {
      pass: walk(actual, expected),
      message: `expected ${describeValue(actual)} to match object ${describeValue(expected)}`,
    }
  },
  toBeInstanceOf: (actual, expected) => ({
    pass: actual instanceof expected,
    message: `expected ${describeValue(actual)} to be an instance of ${expected?.name ?? String(expected)}`,
  }),
  /**
   * `toThrow()` bare, or with a substring/RegExp/Error-class expectation. Under `.not`
   * the thrown error is surfaced in the message, because "expected not to throw" on its
   * own tells you nothing about what went wrong.
   */
  toThrow: (actual, expected) => {
    const error = callAndCatch(actual)
    if (error === undefined) return { pass: false, message: 'expected function to throw' }
    const thrown = `threw ${describeValue(error)}`
    if (expected === undefined) return { pass: true, message: `expected function not to throw, ${thrown}` }
    // An Error instance means "same message", not "same identity" — vitest's rule, and
    // the useful one, since a rethrown cause is often a different object.
    if (expected instanceof Error) {
      const text = error instanceof Error ? error.message : String(error)
      return {
        pass: text === expected.message,
        message: `expected thrown message ${describeValue(expected.message)}, ${thrown}`,
      }
    }
    if (typeof expected === 'function') {
      return {
        pass: error instanceof expected,
        message: `expected ${expected.name}, ${thrown}`,
      }
    }
    const text = error instanceof Error ? error.message : String(error)
    return {
      pass: matchesText(text, expected),
      message: `expected thrown message to match ${String(expected)}, got ${describeValue(text)}`,
    }
  },
}

function build(actual, negated, label) {
  const target = {}
  for (const [name, matcher] of Object.entries(MATCHERS)) {
    target[name] = (...args) => {
      const { pass, message } = matcher(actual, ...args)
      if (pass === negated) fail(annotate(message, negated, label))
      return target
    }
  }
  return target
}

const annotate = (message, negated, label) =>
  `${label ? `${label}: ` : ''}${negated ? `NOT: ${message}` : message}`

/**
 * `.resolves` / `.rejects`: settle the promise first, then run the ordinary matcher on
 * the settled value. Every matcher returns a promise here, so these must be awaited —
 * same as in vitest.
 */
function buildAsync(promise, negated, wantRejection, label) {
  const target = {}
  for (const [name, matcher] of Object.entries(MATCHERS)) {
    target[name] = async (...args) => {
      let settled
      try {
        const value = await promise
        if (wantRejection) fail(`expected promise to reject, it resolved with ${describeValue(value)}`)
        settled = value
      } catch (error) {
        if (!wantRejection) fail(`expected promise to resolve, it rejected with ${describeValue(error)}`)
        if (error instanceof assert.AssertionError) throw error
        settled = error
      }
      // `rejects.toThrow(...)` reads as "the rejection reason looks like this error", so
      // the reason is wrapped back into a thrower for the synchronous matcher.
      const subject = wantRejection && name === 'toThrow' ? () => { throw settled } : settled
      const { pass, message } = matcher(subject, ...args)
      if (pass === negated) fail(annotate(message, negated, label))
      return target
    }
  }
  return target
}

/**
 * `expect(actual)` or `expect(actual, 'what this is')` — vitest takes the label on
 * `expect`, not on the matcher, and it is worth keeping: in a loop over six shops the
 * label is the only thing that says which one failed.
 */
export function expect(actual, label) {
  const api = build(actual, false, label)
  api.not = build(actual, true, label)
  if (isObject(actual) && typeof actual.then === 'function') {
    api.resolves = buildAsync(actual, false, false, label)
    api.resolves.not = buildAsync(actual, true, false, label)
    api.rejects = buildAsync(actual, false, true, label)
    api.rejects.not = buildAsync(actual, true, true, label)
  }
  return api
}

/** Marks a branch that must not be reached — vitest's own escape hatch. */
expect.unreachable = (message = 'this code should not be reached') => fail(message)

/** Present so a stray `expect.assertions()` fails on purpose rather than silently. */
expect.assertions = () => {
  fail('expect.assertions() is not supported by the node:test shim — run under real vitest')
}

export { describe, it, before, after, beforeEach, afterEach }
export const test = it
export const suite = describe
export const beforeAll = before
export const afterAll = after
