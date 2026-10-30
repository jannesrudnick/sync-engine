/** The few IndexedDB calls the engine needs, as promises. */

const done = (t: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = t.onabort = () => reject(t.error)
  })

const result = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })

/**
 * Opens `name` with one object store per entry of `stores` (keyed by `id`).
 * A new `version` drops every store: the cache is refilled by a bootstrap.
 */
export function openDb(name: string, version: number, stores: string[]) {
  const req = indexedDB.open(name, version)
  req.onupgradeneeded = () => {
    const db = req.result
    for (const s of Array.from(db.objectStoreNames)) db.deleteObjectStore(s)
    for (const s of stores) db.createObjectStore(s, { keyPath: "id" })
  }
  return result(req)
}

export const getAll = <T>(db: IDBDatabase, store: string) =>
  result<T[]>(db.transaction(store).objectStore(store).getAll())

/** Runs `fn` in one readwrite transaction over `stores`; resolves on commit. */
export function write(
  db: IDBDatabase,
  stores: string[],
  fn: (store: (name: string) => IDBObjectStore) => void
) {
  const t = db.transaction(stores, "readwrite")
  fn((name) => t.objectStore(name))
  return done(t)
}

/** Deletes the databases whose name starts with `prefix`, except `keep`. */
export async function deleteOthers(prefix: string, keep: string) {
  // Not in every browser (older Firefox): then nothing is cleaned up.
  const all = (await indexedDB.databases?.()) ?? []
  for (const { name } of all)
    if (name?.startsWith(prefix) && name !== keep)
      indexedDB.deleteDatabase(name)
}
