#!/usr/bin/env tsx
/**
 * `npm run db:migrate` — the command-line face of `src/server/db/migrator.ts`.
 *
 * All the logic lives in the migrator; everything here is argument parsing and
 * output, so the integration-test setup can apply migrations by calling a function
 * instead of shelling out to this script.
 *
 *   npm run db:migrate                 apply pending migrations
 *   npm run db:migrate -- --status     list applied and pending, change nothing
 *   npm run db:migrate -- --reset      drop the schema and re-apply from empty
 *   npm run db:migrate -- --to 0005    apply up to and including 0005
 *   npm run db:migrate -- --dry-run    validate and list, apply nothing
 */

import './_bootstrap'

import {
  locateInSql,
  migrate,
  migrationStatus,
  MigrationDriftError,
  MigrationFailedError,
  type MigrationFile,
} from '../src/server/db/migrator'

// ── Output ──────────────────────────────────────────────────────────────────

// Colour only when a human is watching. Piping this into a log file or a CI
// annotation should not fill it with escape sequences.
const useColour = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined
const paint = (code: string) => (s: string) => (useColour ? `\u001b[${code}m${s}\u001b[0m` : s)

const green = paint('32')
const red = paint('31')
const yellow = paint('33')
const dim = paint('2')
const bold = paint('1')

const out = (text: string) => process.stdout.write(text)
const err = (text: string) => process.stderr.write(text)

const label = (migration: MigrationFile) => migration.filename.padEnd(38)

// ── Arguments ───────────────────────────────────────────────────────────────

interface Options {
  reset: boolean
  status: boolean
  dryRun: boolean
  to: string | null
}

function parseArgs(argv: string[]): Options {
  const options: Options = { reset: false, status: false, dryRun: false, to: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--reset':
        options.reset = true
        break
      case '--status':
        options.status = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--to': {
        const value = argv[i + 1]
        if (!value) throw new Error('--to requires a version, e.g. --to 0005')
        options.to = value.padStart(4, '0')
        i += 1
        break
      }
      default:
        throw new Error(`Unknown argument '${String(arg)}'`)
    }
  }
  return options
}

function requireUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local.')
  return url
}

const ssl = process.env.DATABASE_SSL === 'true'

// ── Commands ────────────────────────────────────────────────────────────────

async function showStatus(url: string): Promise<void> {
  const { files, applied, drift, database } = await migrationStatus({ url, ssl })
  out(`\n${bold('chaapo migrate')} ${dim(`→ ${database}`)}\n\n`)

  for (const file of files) {
    const record = applied.get(file.version)
    if (record) {
      const when = record.appliedAt.toISOString().replace('T', ' ').slice(0, 19)
      out(`  ${green('✓')} ${label(file)} ${dim(`${when}  ${record.durationMs} ms`)}\n`)
    } else {
      out(`  ${dim('·')} ${dim(label(file).trimEnd())}\n`)
    }
  }

  out(`\n  ${applied.size} applied, ${files.length - applied.size} pending\n`)
  if (drift.length > 0) {
    out(`\n  ${yellow('drift')}\n${drift.map((d) => `    • ${d}\n`).join('')}`)
    process.exitCode = 1
  }
  out('\n')
}

async function run(url: string, options: Options): Promise<void> {
  const result = await migrate({
    url,
    ssl,
    reset: options.reset,
    to: options.to,
    dryRun: options.dryRun,
    onEvent: (event) => {
      switch (event.type) {
        case 'database-created':
          out(`  ${dim(`created database ${event.database}`)}\n`)
          break
        case 'reset':
          out(`  ${dim(`dropped schema public in ${event.database}`)}\n`)
          break
        case 'applying':
          out(`  ${dim('→')} ${label(event.migration)}`)
          break
        case 'applied':
          out(` ${green('✓')} ${dim(`${event.durationMs} ms`)}\n`)
          break
        case 'failed':
          out(` ${red('✗')}\n\n`)
          break
      }
    },
  })

  if (options.dryRun) {
    if (result.deferred.length === 0) {
      out(`  ${green('✓')} up to date — ${result.alreadyApplied} migration(s) applied\n\n`)
      return
    }
    out(`  would apply ${result.deferred.length} migration(s):\n`)
    for (const migration of result.deferred) out(`    ${dim('·')} ${migration.filename}\n`)
    out('\n')
    return
  }

  if (result.applied.length === 0) {
    out(`  ${green('✓')} up to date — ${result.alreadyApplied} migration(s) applied\n\n`)
    return
  }

  out(`\n  ${green('✓')} applied ${result.applied.length} migration(s) in ${result.totalMs} ms\n`)
  if (result.deferred.length > 0) {
    out(`  ${dim(`${result.deferred.length} deferred by --to ${String(options.to)}`)}\n`)
  }
  out('\n')
}

// ── Entry ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const url = requireUrl()

  if (options.status) {
    await showStatus(url)
    return
  }

  out(`\n${bold('chaapo migrate')} ${dim(`→ ${new URL(url).pathname.slice(1)}`)}\n\n`)
  await run(url, options)
}

function report(error: unknown): void {
  if (error instanceof MigrationDriftError) {
    err(
      `  ${red('migration drift detected')}\n` +
        error.problems.map((p) => `    • ${p}\n`).join('') +
        '\n  An applied migration no longer matches the database, and re-running\n' +
        '  cannot reconcile it. Restore the file, or add a new migration that makes\n' +
        '  the change forwards. In development: npm run db:migrate -- --reset\n\n',
    )
    return
  }

  if (error instanceof MigrationFailedError) {
    const lines = [error.message.replace(`${error.filename} failed: `, '')]
    if (error.sqlState) lines.push(dim(`SQLSTATE ${error.sqlState}`))
    if (error.detail) lines.push(`detail: ${error.detail}`)
    if (error.hint) lines.push(`hint: ${error.hint}`)
    if (error.where) lines.push(`where: ${error.where}`)

    const spot = locateInSql(error.sql, error.position)
    if (spot) {
      lines.push(`at line ${spot.line}:${spot.column}`)
      lines.push(dim(spot.text.slice(0, 120)))
    }

    err(
      `  ${red(`${error.filename} failed`)}\n` +
        lines.map((l) => `         ${l}\n`).join('') +
        `\n  Rolled back. The database is on ${error.at}.\n\n`,
    )
    return
  }

  err(`\n  ${red('migrate failed')}: ${error instanceof Error ? error.message : String(error)}\n\n`)
}

main().catch((error: unknown) => {
  report(error)
  process.exitCode = 1
})
