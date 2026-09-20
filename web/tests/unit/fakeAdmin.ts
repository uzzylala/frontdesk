// An in-memory stand-in for the slice of the Supabase query builder that server/routing.ts uses, so the REAL
// routing code runs against plain arrays. It implements filters (eq, in, is, lt), order/limit, select/update,
// single/maybeSingle and head-count selects — nothing more. An unsupported call throws, so a change to the
// routing queries that the fake can't express fails loudly instead of silently testing nothing.
//
// update() applies to whatever rows the filters match *at execution time*, which is exactly the compare-and-set
// behaviour the routing code relies on (`update … where assigned_agent_id is null`).

type Row = Record<string, unknown>
type Result = { data: unknown; error: { code?: string; message: string } | null; count?: number | null }

export interface Hooks {
  /** Runs just before a query executes; may mutate tables (e.g. to inject a concurrent write). */
  before?: (call: { table: string; op: 'select' | 'update'; filters: Filter[]; values?: Row }) => void
  /** Runs just after an update has been applied, with the rows it changed. */
  afterUpdate?: (call: { table: string; changed: Row[]; values: Row }) => void
  /** Return an error to make an update fail (e.g. a missing column). */
  failUpdate?: (call: { table: string; values: Row }) => { code?: string; message: string } | null
}

type Filter = { kind: 'eq' | 'in' | 'is' | 'lt'; column: string; value: unknown }

export class FakeAdmin {
  tables: Record<string, Row[]>
  hooks: Hooks = {}
  /** Every update applied, in order — for asserting what was written. */
  writes: { table: string; values: Row; ids: unknown[] }[] = []

  constructor(tables: Record<string, Row[]> = {}) {
    this.tables = { agents: [], agent_heartbeats: [], conversations: [], ...tables }
  }

  from(table: string) {
    return new Query(this, table)
  }
}

class Query implements PromiseLike<Result> {
  private filters: Filter[] = []
  private op: 'select' | 'update' = 'select'
  private values: Row = {}
  private wantRows = false
  private orderBy: { column: string; ascending: boolean } | null = null
  private max: number | null = null
  private singleMode: 'single' | 'maybe' | null = null
  private head = false
  private countMode = false

  constructor(
    private db: FakeAdmin,
    private table: string,
  ) {}

  select(_columns = '*', options?: { count?: 'exact'; head?: boolean }) {
    if (this.op === 'update') this.wantRows = true
    if (options?.count) this.countMode = true
    if (options?.head) this.head = true
    return this
  }
  update(values: Row) {
    this.op = 'update'
    this.values = values
    return this
  }
  eq(column: string, value: unknown) { this.filters.push({ kind: 'eq', column, value }); return this }
  in(column: string, value: unknown[]) { this.filters.push({ kind: 'in', column, value }); return this }
  is(column: string, value: unknown) { this.filters.push({ kind: 'is', column, value }); return this }
  lt(column: string, value: unknown) { this.filters.push({ kind: 'lt', column, value }); return this }
  order(column: string, options?: { ascending?: boolean }) { this.orderBy = { column, ascending: options?.ascending ?? true }; return this }
  limit(n: number) { this.max = n; return this }
  maybeSingle() { this.singleMode = 'maybe'; return this }
  /** Like maybeSingle, except that no row is an error (supabase-js semantics). */
  single() { this.singleMode = 'single'; return this }

  private matches(row: Row): boolean {
    return this.filters.every((f) => {
      const v = row[f.column]
      if (f.kind === 'eq') return v === f.value
      if (f.kind === 'is') return f.value === null ? v === null || v === undefined : v === f.value
      if (f.kind === 'in') return (f.value as unknown[]).includes(v)
      return typeof v === 'string' && typeof f.value === 'string' ? new Date(v).getTime() < new Date(f.value).getTime() : (v as number) < (f.value as number)
    })
  }

  private run(): Result {
    const rows = this.db.tables[this.table]
    if (!rows) throw new Error(`FakeAdmin: no table "${this.table}"`)
    this.db.hooks.before?.({ table: this.table, op: this.op, filters: this.filters, values: this.op === 'update' ? this.values : undefined })

    if (this.op === 'update') {
      const failure = this.db.hooks.failUpdate?.({ table: this.table, values: this.values })
      if (failure) return { data: null, error: failure }
      const changed = rows.filter((r) => this.matches(r))
      for (const r of changed) Object.assign(r, this.values)
      this.db.writes.push({ table: this.table, values: this.values, ids: changed.map((r) => r.id ?? r.agent_id) })
      this.db.hooks.afterUpdate?.({ table: this.table, changed, values: this.values })
      return { data: this.wantRows ? changed.map((r) => ({ ...r })) : null, error: null }
    }

    let out = rows.filter((r) => this.matches(r)).map((r) => ({ ...r }))
    if (this.orderBy) {
      const { column, ascending } = this.orderBy
      out.sort((a, b) => {
        const x = a[column] as string | number
        const y = b[column] as string | number
        return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1)
      })
    }
    if (this.max !== null) out = out.slice(0, this.max)
    if (this.countMode) return { data: this.head ? null : out, error: null, count: out.length }
    if (this.singleMode) {
      if (out.length === 0) return this.singleMode === 'single' ? { data: null, error: { message: 'no rows' } } : { data: null, error: null }
      return { data: out[0], error: null }
    }
    return { data: out, error: null }
  }

  then<T1 = Result, T2 = never>(onfulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null, onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null): PromiseLike<T1 | T2> {
    return Promise.resolve().then(() => this.run()).then(onfulfilled, onrejected)
  }
}
