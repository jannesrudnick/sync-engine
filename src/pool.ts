/**
 * The object pool: every row of every synced model, in memory.
 *
 * Two layers, like Linear's: `base` is what the server confirmed (bootstrap
 * plus sync actions), and the pending transactions are laid over it in
 * order. What views read (`get`, `rows`) is base with the pending changes
 * applied. A sync action for a row with a pending change rebases it: the new
 * server state goes into base and the change is applied on top again. A
 * transaction that fails is dropped and its rows fall back to base; one the
 * server confirmed is dropped once base has its effect.
 */

export type Row = { id: string } & Record<string, unknown>

/** One optimistic change of a transaction. */
export type Change =
  | { model: string; id: string; op: "set"; row: Row }
  | { model: string; id: string; op: "patch"; patch: Record<string, unknown> }
  | { model: string; id: string; op: "delete" }

/** A server-side change, as `sync_actions` stores it. */
export type SyncAction = {
  id: number
  model: string
  model_id: string
  action: "I" | "U" | "D"
  data: Row | null
}

export class Pool {
  private base = new Map<string, Map<string, Row>>()
  private visible = new Map<string, Map<string, Row>>()
  private layers: { key: string; changes: Change[] }[] = []
  private versions = new Map<string, number>()
  private arrays = new Map<string, { version: number; rows: Row[] }>()
  private listeners = new Set<() => void>()

  constructor(readonly models: readonly string[]) {
    for (const m of models) {
      this.base.set(m, new Map())
      this.visible.set(m, new Map())
      this.versions.set(m, 0)
    }
  }

  get<T extends Row>(model: string, id: string) {
    return this.visible.get(model)?.get(id) as T | undefined
  }

  /** All rows of `model`; the same array until one of them changes. */
  rows<T extends Row>(model: string): T[] {
    const version = this.version(model)
    const cached = this.arrays.get(model)
    if (cached?.version === version) return cached.rows as T[]
    const rows = Array.from(this.visible.get(model)!.values())
    this.arrays.set(model, { version, rows })
    return rows as T[]
  }

  /** Grows with every change of `model`. */
  version(model: string) {
    return this.versions.get(model) ?? 0
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /** The server rows as they are now, e.g. from a bootstrap. */
  load(rows: Record<string, Row[]>) {
    for (const m of this.models) {
      const map = new Map<string, Row>()
      for (const r of rows[m] ?? []) map.set(r.id, r)
      this.base.set(m, map)
    }
    this.recomputeAll()
  }

  /** Applies server changes to base; returns the rows to store and delete. */
  apply(actions: SyncAction[]) {
    const touched = new Map<string, Set<string>>()
    for (const a of actions) {
      const map = this.base.get(a.model)
      if (!map) continue
      if (a.action === "D" || !a.data) map.delete(a.model_id)
      else map.set(a.model_id, a.data)
      if (!touched.has(a.model)) touched.set(a.model, new Set())
      touched.get(a.model)!.add(a.model_id)
    }
    for (const [model, ids] of touched)
      for (const id of ids) this.recompute(model, id)
    this.notify(touched.keys())
    return touched
  }

  /** The confirmed row, without pending changes. */
  baseRow(model: string, id: string) {
    return this.base.get(model)?.get(id)
  }

  /** Lays a transaction's changes over base. */
  push(key: string, changes: Change[]) {
    this.layers.push({ key, changes })
    for (const c of changes) this.recompute(c.model, c.id)
    this.notify(changes.map((c) => c.model))
  }

  /** Takes a transaction's changes off again (failed or confirmed). */
  drop(key: string) {
    const layer = this.layers.find((l) => l.key === key)
    if (!layer) return
    this.layers = this.layers.filter((l) => l !== layer)
    for (const c of layer.changes) this.recompute(c.model, c.id)
    this.notify(layer.changes.map((c) => c.model))
  }

  /** Tells every subscriber to read again (e.g. once the pool is ready). */
  touch() {
    this.notify(this.models)
  }

  private recompute(model: string, id: string) {
    let row = this.base.get(model)?.get(id)
    for (const { changes } of this.layers)
      for (const c of changes) {
        if (c.model !== model || c.id !== id) continue
        if (c.op === "set") row = c.row
        else if (c.op === "delete") row = undefined
        else if (row) row = { ...row, ...c.patch }
      }
    const visible = this.visible.get(model)
    if (!visible) return
    if (row) visible.set(id, row)
    else visible.delete(id)
  }

  private recomputeAll() {
    for (const m of this.models) {
      this.visible.set(m, new Map(this.base.get(m)))
      for (const { changes } of this.layers)
        for (const c of changes) if (c.model === m) this.recompute(m, c.id)
    }
    this.notify(this.models)
  }

  private notify(models: Iterable<string>) {
    for (const m of new Set(models))
      this.versions.set(m, (this.versions.get(m) ?? 0) + 1)
    for (const l of this.listeners) l()
  }
}
