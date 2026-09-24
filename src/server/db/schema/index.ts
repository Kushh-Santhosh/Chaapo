/**
 * The database schema, assembled.
 *
 * Import from here (`@/server/db/schema`), not from the individual modules — the
 * drizzle client is constructed with this object so that `db.query.*` works and so
 * that there is exactly one place to look for the full table list.
 *
 * Module order below is the dependency order, which is also the migration order:
 *
 *   enums → identity → geo → shops → catalogue → files → orders → money
 *         → notifications → trust → config → analytics
 *
 * The graph is acyclic by construction: a module declares a foreign key only when the
 * target table lives in the same module or an earlier one. Cross-module links that
 * would create a cycle (`orders.dispute_id`, `files.order_id`, `ledger_entries.payout_id`)
 * are declared as plain uuid columns here and constrained by `ALTER TABLE` in SQL.
 * The database enforces every foreign key either way.
 */

export * from './enums'
export * from './identity'
export * from './geo'
export * from './shops'
export * from './catalogue'
export * from './files'
export * from './orders'
export * from './money'
export * from './notifications'
export * from './trust'
export * from './config'
export * from './analytics'
