/** The few IndexedDB calls the engine needs, as promises. */
const done = (t) => new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error);
});
const result = (r) => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
});
/**
 * Opens `name` with one object store per entry of `stores` (keyed by `id`).
 * A new `version` drops every store: the cache is refilled by a bootstrap.
 */
export function openDb(name, version, stores) {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of Array.from(db.objectStoreNames))
            db.deleteObjectStore(s);
        for (const s of stores)
            db.createObjectStore(s, { keyPath: "id" });
    };
    return result(req);
}
export const getAll = (db, store) => result(db.transaction(store).objectStore(store).getAll());
/** Runs `fn` in one readwrite transaction over `stores`; resolves on commit. */
export function write(db, stores, fn) {
    const t = db.transaction(stores, "readwrite");
    fn((name) => t.objectStore(name));
    return done(t);
}
/** Deletes the databases whose name starts with `prefix`, except `keep`. */
export async function deleteOthers(prefix, keep) {
    // Not in every browser (older Firefox): then nothing is cleaned up.
    const all = (await indexedDB.databases?.()) ?? [];
    for (const { name } of all)
        if (name?.startsWith(prefix) && name !== keep)
            indexedDB.deleteDatabase(name);
}
