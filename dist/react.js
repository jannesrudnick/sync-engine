"use client";
import { use, useSyncExternalStore } from "react";
/** The engine of this page; set once by the app (see README). */
let engine = null;
export function setEngine(e) {
    engine = e;
}
export function getEngine() {
    if (!engine)
        throw new Error("No sync engine: call setEngine first.");
    return engine;
}
export const hasEngine = () => engine !== null;
// Without an engine (signed out) nothing is ever ready.
const subscribe = (listener) => engine ? engine.pool.subscribe(listener) : () => { };
const isReady = () => !!engine?.isReady;
/**
 * A view of the pool: `compute(pool, key)`, recomputed only when one of
 * `models` changed, so the same key gives the same object until then.
 * ponytail: views scan whole models; add indexes by foreign key once a
 * model holds tens of thousands of rows.
 */
export function view(models, compute) {
    const cache = new Map();
    return (key = "") => {
        const pool = getEngine().pool;
        const at = models.map((m) => pool.version(m)).join(",");
        const hit = cache.get(key);
        if (hit?.at === at)
            return hit.value;
        const value = compute(pool, key);
        // Keys come and go (search terms); keep the recent ones.
        if (cache.size > 50)
            cache.clear();
        cache.set(key, { at, value });
        return value;
    };
}
/**
 * Reads a view and re-renders when it changes. Undefined until the pool
 * has data, and while rendering on the server.
 */
export function useView(read, key = "") {
    return useSyncExternalStore(subscribe, () => (isReady() ? read(key) : undefined), () => undefined);
}
/**
 * `useView` for views below a `<SyncGate>`: suspends instead of returning
 * undefined (only in the browser, where the pool fills).
 */
export function useLoadedView(read, key = "") {
    const value = useView(read, key);
    if (value === undefined)
        use(getEngine().ready);
    return value;
}
/**
 * Renders `fallback` on the server and until the pool has data, then
 * `children`. Wraps everything that reads with `useLoadedView`.
 */
export function SyncGate({ fallback, children, }) {
    const ready = useSyncExternalStore(subscribe, isReady, () => false);
    return ready ? children : fallback;
}
