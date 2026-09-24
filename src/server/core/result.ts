import { type AppError, toAppError } from './errors'

/**
 * Result.
 *
 * Domain functions return `Result` for outcomes that are part of the product —
 * "this shop is closed", "that pickup code is wrong", "the order already moved
 * on" — and throw only for programmer errors and genuine infrastructure
 * failures. That distinction matters at the HTTP layer: an `err` is a normal
 * response, a throw is a page in the error log.
 *
 * Deliberately minimal: `ok`/`err`, a couple of combinators, and an `unwrap`
 * that throws. No monad library, no fluent chain — the domain code reads better
 * with plain early returns.
 */

export interface Ok<T> {
  readonly ok: true
  readonly value: T
}

export interface Err<E> {
  readonly ok: false
  readonly error: E
}

export type Result<T, E = AppError> = Ok<T> | Err<E>

export function ok(): Result<void, never>
export function ok<T>(value: T): Result<T, never>
export function ok<T>(value?: T): Result<T | undefined, never> {
  return { ok: true, value }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok
}

/** Get the value or throw the error. Use at boundaries that already have a catch. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value
  throw result.error instanceof Error ? result.error : toAppError(result.error)
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback
}

export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result
}

export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error))
}

/**
 * Collect an array of results into a result of an array, failing on the first
 * error. Used when validating a batch of order items.
 */
export function allResults<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = []
  for (const result of results) {
    if (!result.ok) return result
    values.push(result.value)
  }
  return ok(values)
}

/** Run a throwing function and capture the failure as an AppError result. */
export async function attempt<T>(fn: () => Promise<T> | T): Promise<Result<T, AppError>> {
  try {
    return ok(await fn())
  } catch (error) {
    return err(toAppError(error))
  }
}
