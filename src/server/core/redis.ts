/**
 * The Redis connection.
 *
 * Redis holds four kinds of thing in this system, and it is worth being precise about
 * which are load-bearing, because it changes what a Redis outage means:
 *
 *   • **Rate-limit counters** — lost on restart, and that is fine. A counter reset
 *     means one extra allowed attempt, not a broken invariant.
 *   • **BullMQ queues** — durable in Redis, and the reason `appendOnly`/persistence
 *     matters in the deployment. A lost queue is a lost `file.process` job, which is
 *     a customer's upload stuck in `processing`. The outbox pattern in the database is
 *     what makes that recoverable (§F), not Redis itself.
 *   • **SSE fan-out (pub/sub)** — best effort. A dropped message means a browser sees
 *     the status one poll later, so the client also re-fetches on reconnect.
 *   • **Short-lived caches** — discovery results, config snapshots. Always
 *     recomputable.
 *
 * Sessions are *not* here, despite the plan's table saying "Redis-backed sessions".
 * They live in `sessions` in Postgres, because "sign out every device" and the device
 * list in §45 need a queryable, auditable record — and because a session that vanishes
 * when Redis restarts logs out every shop mid-shift.
 *
 * `getRedis()` returns a lazily-created singleton. Everything that wants Redis for
 * *logic* (rate limiting, locks) should take the narrow `RedisLike` port instead, so it
 * can be tested against a fake — see `rate-limit.ts`.
 */

import Redis, { type RedisOptions } from 'ioredis'

import { getConfig } from '../config'
import { logger } from './logger'

/**
 * The slice of Redis this codebase actually uses for logic.
 *
 * Narrow on purpose. A module that takes this can be tested with twenty lines of Map,
 * and the alternative — mocking ioredis — tests the mock.
 */
export interface RedisLike {
  incr(key: string): Promise<number>
  pexpire(key: string, milliseconds: number): Promise<number>
  pttl(key: string): Promise<number>
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: 'PX', ttl: number, exists?: 'NX'): Promise<'OK' | null>
  del(...keys: string[]): Promise<number>
  ping(): Promise<string>
}

let client: Redis | null = null

function redisOptions(): RedisOptions {
  const { app } = getConfig()
  return {
    // ioredis queues commands while disconnected by default. For a rate limiter that
    // is exactly wrong: a queued INCR resolves minutes later, long after the request
    // it was guarding has been answered. Fail fast and let the caller's
    // `onUnavailable` policy decide.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    connectTimeout: 3_000,
    // A command that has not answered in a second is not going to help this request.
    commandTimeout: 1_000,
    // Exponential-ish, capped. Reconnecting is the background's job, not a request's.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    // Read-only replica failover: ioredis retries the command once the primary moves.
    reconnectOnError: (error) => error.message.includes('READONLY'),
    connectionName: `chaapo-${app.env}`,
    lazyConnect: true,
  }
}

/** The process Redis client. Connected on first command. */
export function getRedis(): Redis {
  if (client) return client

  const created = new Redis(getConfig().redis.url, redisOptions())

  // An error event with no in-flight command is a connection problem. ioredis emits
  // it on every reconnect attempt, so this is `warn`: it is noise during a rolling
  // restart and a real signal only when it does not stop.
  created.on('error', (error: Error) => {
    logger.warn('redis connection error', { message: error.message })
  })
  created.on('end', () => {
    logger.warn('redis connection closed')
  })

  client = created
  return created
}

/** Close the connection. Called by the worker's shutdown handler and test teardown. */
export async function closeRedis(): Promise<void> {
  const existing = client
  client = null
  if (!existing) return
  try {
    // `quit` waits for in-flight commands; `disconnect` would drop a queue ack.
    await existing.quit()
  } catch {
    existing.disconnect()
  }
}

/** Test-only: inject a client (or a fake satisfying `RedisLike`). */
export function __setRedisForTests(next: Redis | null): void {
  client = next
}

/**
 * Health check for the readiness probe and the admin system page.
 *
 * Reports latency, because a Redis answering in 400 ms will make every request slow
 * before it makes any request fail.
 */
export async function checkRedisHealth(): Promise<{
  ok: boolean
  latencyMs: number
  error?: string
}> {
  const started = process.hrtime.bigint()
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6
  try {
    const reply = await getRedis().ping()
    return { ok: reply === 'PONG', latencyMs: elapsed() }
  } catch (error) {
    return {
      ok: false,
      latencyMs: elapsed(),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
