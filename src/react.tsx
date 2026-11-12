"use client"

import { use, useEffect, useMemo, useSyncExternalStore } from "react"

import { draftVersion, onDraftChange, type Draft } from "./draft"
import { queryKey, type SyncEngine } from "./engine"
import type { Pool } from "./pool"
import type { ModelName, QuerySpec, RowOf } from "./types"

/** The engine of this page; set once by the app (see README). */
let engine: SyncEngine | null = null

export function setEngine(e: SyncEngine) {
  engine = e
}

export function getEngine() {
  if (!engine) throw new Error("No sync engine: call setEngine first.")
  return engine
}

export const hasEngine = () => engine !== null

/**
 * `use` must be called in every render once it suspended: with this
 * promise when there is nothing to wait for (React reads `status` and does
 * not suspend).
 */
const settled = Object.assign(Promise.resolve(), {
  status: "fulfilled",
  value: undefined,
})

// Without an engine (signed out) nothing is ever ready.
const subscribe = (listener: () => void) =>
  engine ? engine.pool.subscribe(listener) : () => {}
const isReady = () => !!engine?.isReady

/**
 * A view of the pool: `compute(pool, key)`, recomputed only when one of
 * `models` changed, so the same key gives the same object until then.
 * ponytail: views scan whole models; add indexes by foreign key once a
 * model holds tens of thousands of rows.
 */
export function view<T>(
  models: readonly ModelName[],
  compute: (pool: Pool, key: string) => T
) {
  const cache = new Map<string, { at: string; value: T }>()
  return (key = "") => {
    const pool = getEngine().pool
    const at = models.map((m) => pool.version(m)).join(",")
    const hit = cache.get(key)
    if (hit?.at === at) return hit.value
    const value = compute(pool, key)
    // Keys come and go (search terms); keep the recent ones.
    if (cache.size > 50) cache.clear()
    cache.set(key, { at, value })
    return value
  }
}

/**
 * Reads a view and re-renders when it changes. Undefined until the pool
 * has data, and while rendering on the server.
 */
export function useView<T>(read: (key: string) => T, key = "") {
  return useSyncExternalStore(
    subscribe,
    () => (isReady() ? read(key) : undefined),
    () => undefined
  )
}

/**
 * `useView` for views below a `<SyncGate>`: suspends instead of returning
 * undefined (only in the browser, where the pool fills).
 */
export function useLoadedView<T>(read: (key: string) => T, key = "") {
  const value = useView(read, key)
  use(value === undefined ? getEngine().ready : settled)
  return value as T
}

/**
 * Renders `fallback` on the server and until the pool has data, then
 * `children`. Wraps everything that reads with `useLoadedView`.
 */
export function SyncGate({
  fallback,
  children,
}: {
  fallback: React.ReactNode
  children: React.ReactNode
}) {
  const ready = useSyncExternalStore(subscribe, isReady, () => false)
  return ready ? children : fallback
}

/**
 * A draft of a row for a form (see `SyncEngine.draft`): the same draft
 * across renders, re-rendering when fields are set or the row changes in
 * the pool. Undefined until the pool has the row, and once it is deleted.
 *
 *   const issue = useDraft("issues", id) // Draft<Issue>
 *   <input value={issue.title} onChange={(e) => (issue.title = e.target.value)} />
 *   <button disabled={!issue.isDirty} onClick={() => issue.save()}>Save</button>
 */
export function useDraft<M extends ModelName>(model: M, id: string) {
  const exists = useSyncExternalStore(
    subscribe,
    () => isReady() && !!getEngine().pool.get(model, id),
    () => false
  )
  const draft = useMemo(
    () => (exists ? getEngine().draft(model, id) : undefined),
    [model, id, exists]
  )
  // Fields read through to the pool: re-render when the model changes too.
  useSyncExternalStore(
    subscribe,
    () => (isReady() ? getEngine().pool.version(model) : 0),
    () => 0
  )
  useSyncExternalStore(
    (listener) => (draft ? onDraftChange(draft, listener) : () => {}),
    () => (draft ? draftVersion(draft) : 0),
    () => 0
  )
  return draft as Draft<RowOf<M>> | undefined
}

/**
 * The rows of a query (see `QuerySpec`), fetched from the server view
 * `source` and kept fresh while the component is mounted. Undefined until
 * the first fetch (or from the cache of an earlier visit right away).
 *
 *   const issues = useQuery({
 *     model: "issues",
 *     source: "open_issues",
 *     params: { project_id: projectId },
 *     filter: (i) => i.project_id === projectId && i.status !== "done",
 *   })
 */
export function useQuery<M extends ModelName>(
  spec: QuerySpec<M>
): RowOf<M>[] | undefined {
  const key = queryKey(spec)
  useEffect(
    () => (hasEngine() ? getEngine().watchQuery(spec) : undefined),
    // The key covers what the fetch depends on; `spec` is a new object
    // every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key]
  )
  return useSyncExternalStore<RowOf<M>[] | undefined>(
    subscribe,
    () => (isReady() ? getEngine().queryRows(spec) : undefined),
    () => undefined
  )
}

/**
 * `useQuery` below a `<SyncGate>`: suspends until the first fetch instead
 * of returning undefined. A failed first fetch goes to the error boundary.
 */
export function useLoadedQuery<M extends ModelName>(spec: QuerySpec<M>) {
  const rows = useQuery(spec)
  use(rows === undefined ? getEngine().loadQuery(spec) : settled)
  return rows as RowOf<M>[]
}
