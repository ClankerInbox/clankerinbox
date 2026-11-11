// A D1 binding on node:sqlite, so the Worker's SQL runs for real in tests.
// Only the calls the Worker uses: prepare().bind().all()/first()/run(), and exec().

import { DatabaseSync } from 'node:sqlite'

// node:sqlite warns once that it is experimental; the warning is noise in test output.
const emit = process.emitWarning
process.emitWarning = ((w: any, ...rest: any[]) => {
  if (String(w?.message ?? w).includes('SQLite is an experimental')) return
  return (emit as any).call(process, w, ...rest)
}) as typeof process.emitWarning

class Statement {
  db: DatabaseSync
  sql: string
  values: unknown[]
  constructor(db: DatabaseSync, sql: string, values: unknown[] = []) {
    this.db = db
    this.sql = sql
    this.values = values
  }
  bind(...values: unknown[]): Statement {
    return new Statement(this.db, this.sql, values)
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true }> {
    const rows = this.db.prepare(this.sql).all(...(this.values as any[])) as T[]
    return { results: rows.map((r) => ({ ...r })), success: true }
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.values as any[])) as T | undefined
    return row ? { ...row } : null
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const r = this.db.prepare(this.sql).run(...(this.values as any[]))
    return { success: true, meta: { changes: Number(r.changes) } }
  }
}

export class FakeD1 {
  db = new DatabaseSync(':memory:')
  prepare(sql: string): Statement {
    return new Statement(this.db, sql)
  }
  async exec(sql: string): Promise<void> {
    this.db.exec(sql)
  }
}
