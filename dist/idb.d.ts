/** The few IndexedDB calls the engine needs, as promises. */
/**
 * Opens `name` with one object store per entry of `stores` (keyed by `id`).
 * A new `version` drops every store: the cache is refilled by a bootstrap.
 */
export declare function openDb(name: string, version: number, stores: string[]): Promise<IDBDatabase>;
export declare const getAll: <T>(db: IDBDatabase, store: string) => Promise<T[]>;
/** Runs `fn` in one readwrite transaction over `stores`; resolves on commit. */
export declare function write(db: IDBDatabase, stores: string[], fn: (store: (name: string) => IDBObjectStore) => void): Promise<void>;
/** Deletes the databases whose name starts with `prefix`, except `keep`. */
export declare function deleteOthers(prefix: string, keep: string): Promise<void>;
