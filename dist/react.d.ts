import type { SyncEngine } from "./engine";
import type { Pool } from "./pool";
export declare function setEngine(e: SyncEngine): void;
export declare function getEngine(): SyncEngine;
export declare const hasEngine: () => boolean;
/**
 * A view of the pool: `compute(pool, key)`, recomputed only when one of
 * `models` changed, so the same key gives the same object until then.
 * ponytail: views scan whole models; add indexes by foreign key once a
 * model holds tens of thousands of rows.
 */
export declare function view<T>(models: readonly string[], compute: (pool: Pool, key: string) => T): (key?: string) => T;
/**
 * Reads a view and re-renders when it changes. Undefined until the pool
 * has data, and while rendering on the server.
 */
export declare function useView<T>(read: (key: string) => T, key?: string): T | undefined;
/**
 * `useView` for views below a `<SyncGate>`: suspends instead of returning
 * undefined (only in the browser, where the pool fills).
 */
export declare function useLoadedView<T>(read: (key: string) => T, key?: string): T;
/**
 * Renders `fallback` on the server and until the pool has data, then
 * `children`. Wraps everything that reads with `useLoadedView`.
 */
export declare function SyncGate({ fallback, children, }: {
    fallback: React.ReactNode;
    children: React.ReactNode;
}): import("react").ReactNode;
