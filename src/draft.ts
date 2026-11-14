import type { SyncEngine } from "./engine"
import type { Change, ModelName, Row } from "./types"

/**
 * Drafts, like Linear's models: a row you assign fields on and then
 * `save()`. Saving is an ordinary transaction (`SyncEngine.commit`) with a
 * generic server mutation, so the optimistic update, the queue in IndexedDB,
 * rollback and rebase all work as for any other edit.
 *
 * - Assigning a field changes the row in the pool at once (its unsaved
 *   layer), so every view shows it before `save()`, as in Linear.
 *   `discard()` takes it back. Unsaved edits live in memory only.
 * - There is one draft per row (`SyncEngine.draft` returns the same
 *   object), so everyone editing a row edits the same model.
 * - Fields you have not set read through to the pool, so a draft shows
 *   what other tabs and users change in the meantime.
 * - `save()` sends only the fields that differ from the saved row, as a
 *   patch: two people editing different fields of a row both win. The
 *   engine remembers the old values, so `SyncEngine.undo()` can put them
 *   back.
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

/**
 * A saved edit, for undo: the fields before and after (`before` null for a
 * created row).
 */
export type Edit = {
  model: string
  id: string
  before: Record<string, unknown> | null
  after: Record<string, unknown>
}

/** A row you assign fields on; `save()` commits them. */
export type Draft<T extends { id: string } = Row> = Omit<T, "id"> & {
  readonly id: string
} & DraftMethods

const RESERVED = new Set(["save", "delete", "discard", "isDirty", "isNew"])

type State = {
  changes: Record<string, unknown>
  isNew: boolean
  version: number
  listeners: Set<() => void>
}

const states = new WeakMap<object, State>()

type Engine = Pick<SyncEngine, "pool" | "commit"> & {
  remember(edit: Edit): void
}

export function makeDraft<T extends { id: string }>(
  engine: Engine,
  model: string,
  id: string,
  isNew: boolean,
  fields: Record<string, unknown> = {}
): Draft<T> {
  if (!engine.pool.models.includes(model))
    throw new Error(`Unknown model "${model}".`)
  // The draft mutations are not among the app's registered ones.
  const commit = engine.commit as (
    name: string,
    args: unknown[],
    changes: Change[]
  ) => Promise<string | undefined>
  const state: State = {
    changes: {},
    isNew,
    version: 0,
    listeners: new Set(),
  }
  // The row with this draft's unsaved fields (the pool shows them).
  const current = () =>
    state.isNew
      ? undefined
      : (engine.pool.get(model as ModelName, id) as Row | undefined)
  const saved = () => engine.pool.saved(model, id)
  const showUnsaved = () =>
    engine.pool.setUnsaved(model, id, state.isNew ? null : state.changes)
  const changed = () => {
    state.version++
    for (const l of state.listeners) l()
  }
  const dirtyPatch = () => {
    const row = saved()
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
        engine.remember({ model, id, before: null, after: values })
        return commit.call(engine, DRAFT_MUTATIONS.create, [model, id, values], [
          { model, id, op: "set", row } as Change,
        ])
      }
      const patch = dirtyPatch()
      const row = saved()
      state.changes = {}
      changed()
      // The transaction goes on first, then the unsaved layer comes off:
      // the view never falls back to the old values in between.
      const result =
        Object.keys(patch).length && row
          ? commit.call(engine, DRAFT_MUTATIONS.update, [model, id, patch], [
              { model, id, op: "patch", patch } as Change,
            ])
          : undefined
      showUnsaved()
      if (!result)
        return Promise.resolve(
          row ? undefined : `The ${model} row ${id} no longer exists.`
        )
      engine.remember({
        model,
        id,
        before: Object.fromEntries(Object.keys(patch).map((k) => [k, row![k]])),
        after: patch,
      })
      return result
    },
    delete() {
      const wasNew = state.isNew
      state.changes = {}
      changed()
      showUnsaved()
      if (wasNew) return Promise.resolve(undefined)
      return commit.call(engine, DRAFT_MUTATIONS.delete, [model, id], [
        { model, id, op: "delete" } as Change,
      ])
    },
    discard() {
      state.changes = {}
      changed()
      showUnsaved()
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
      showUnsaved()
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
