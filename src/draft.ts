import type { SyncEngine } from "./engine"
import type { Row } from "./pool"

/**
 * Drafts, after Linear's models: a row you assign fields on and then
 * `save()`. Saving is an ordinary transaction (`SyncEngine.commit`) with a
 * generic server mutation, so the optimistic update, the queue in IndexedDB,
 * rollback and rebase all work as for any other edit.
 *
 * - Fields you have not set read through to the pool, so a draft shows
 *   what other tabs and users change in the meantime.
 * - `save()` sends only the fields that differ from the pool now, as a
 *   patch: two people editing different fields of a row both win.
 * - A draft from `SyncEngine.create` is new: it is not in the pool until
 *   `save()`, which inserts it.
 *
 * The server runs the mutations of `DRAFT_MUTATIONS`; `runDraftMutation`
 * (Supabase) does that for the tables you allow.
 */

/** The server mutations a draft sends. Args: `[model, id, fields]`, `[model, id]` for delete. */
export const DRAFT_MUTATIONS = {
  create: "sync.create",
  update: "sync.update",
  delete: "sync.delete",
} as const

export type DraftMethods = {
  /**
   * Commits the changed fields (all of them for a new draft). Resolves like
   * `commit`: to the error message once it failed and was rolled back, or
   * undefined once the server ran it. Without changes it does nothing.
   */
  save(): Promise<string | undefined>
  /** Deletes the row (a new draft is only discarded). */
  delete(): Promise<string | undefined>
  /** Forgets the fields set since the last save. */
  discard(): void
  /** Whether fields were set that differ from the pool. */
  readonly isDirty: boolean
  /** Whether the row is not saved yet (from `create`). */
  readonly isNew: boolean
}

/** A row you assign fields on; `save()` commits them. */
export type Draft<T extends Row = Row> = T & DraftMethods

const RESERVED = new Set(["save", "delete", "discard", "isDirty", "isNew"])

type State = {
  changes: Record<string, unknown>
  isNew: boolean
  version: number
  listeners: Set<() => void>
}

const states = new WeakMap<object, State>()

type Engine = Pick<SyncEngine, "pool" | "commit">

export function makeDraft<T extends Row>(
  engine: Engine,
  model: string,
  id: string,
  isNew: boolean,
  fields: Record<string, unknown> = {}
): Draft<T> {
  if (!engine.pool.models.includes(model))
    throw new Error(`Unknown model "${model}".`)
  const state: State = {
    changes: {},
    isNew,
    version: 0,
    listeners: new Set(),
  }
  const current = () =>
    state.isNew ? undefined : engine.pool.get(model, id)
  const changed = () => {
    state.version++
    for (const l of state.listeners) l()
  }
  const dirtyPatch = () => {
    const row = current()
    const patch: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(state.changes))
      if (!row || !same(row[k], v)) patch[k] = v
    return patch
  }

  const methods: DraftMethods = {
    save() {
      if (state.isNew) {
        const values = state.changes
        const row: Row = { ...values, id }
        state.isNew = false
        state.changes = {}
        changed()
        return engine.commit(DRAFT_MUTATIONS.create, [model, id, values], [
          { model, id, op: "set", row },
        ])
      }
      const patch = dirtyPatch()
      state.changes = {}
      changed()
      if (!Object.keys(patch).length) return Promise.resolve(undefined)
      if (!current())
        return Promise.resolve(`The ${model} row ${id} no longer exists.`)
      return engine.commit(DRAFT_MUTATIONS.update, [model, id, patch], [
        { model, id, op: "patch", patch },
      ])
    },
    delete() {
      const wasNew = state.isNew
      state.changes = {}
      changed()
      if (wasNew) return Promise.resolve(undefined)
      return engine.commit(DRAFT_MUTATIONS.delete, [model, id], [
        { model, id, op: "delete" },
      ])
    },
    discard() {
      state.changes = {}
      changed()
    },
    get isDirty() {
      return state.isNew
        ? true
        : Object.keys(dirtyPatch()).length > 0
    },
    get isNew() {
      return state.isNew
    },
  }

  const keys = () =>
    Array.from(
      new Set(["id", ...Object.keys(current() ?? {}), ...Object.keys(state.changes)])
    )

  const proxy: Record<string, unknown> = new Proxy({}, {
    get(_, key) {
      if (typeof key === "symbol") return undefined
      if (RESERVED.has(key))
        return Reflect.get(methods, key, methods)
      if (key === "id") return id
      if (key in state.changes) return state.changes[key]
      return current()?.[key]
    },
    set(_, key, value) {
      if (typeof key === "symbol" || RESERVED.has(key) || key === "id")
        throw new Error(`Cannot set "${String(key)}" on a draft.`)
      state.changes[key] = value
      changed()
      return true
    },
    has(_, key) {
      return typeof key === "string" && (RESERVED.has(key) || keys().includes(key))
    },
    ownKeys: () => keys(),
    getOwnPropertyDescriptor(_, key) {
      if (typeof key !== "string" || !keys().includes(key)) return undefined
      return {
        value: proxy[key],
        writable: key !== "id",
        enumerable: true,
        configurable: true,
      }
    },
    deleteProperty() {
      throw new Error("Set a field to null instead of deleting it.")
    },
  })

  states.set(proxy, state)
  for (const [k, v] of Object.entries(fields)) if (k !== "id") proxy[k] = v
  return proxy as Draft<T>
}

/** For `useDraft`: calls `listener` when fields are set or saved. */
export function onDraftChange(draft: object, listener: () => void) {
  const state = states.get(draft)
  if (!state) return () => {}
  state.listeners.add(listener)
  return () => void state.listeners.delete(listener)
}

/** For `useDraft`: grows with every change of the draft. */
export function draftVersion(draft: object) {
  return states.get(draft)?.version ?? 0
}

/** Equal values, also for jsonb columns (objects, arrays). */
function same(a: unknown, b: unknown) {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}
