import { type Draft } from "./draft";
import type { SyncEngine } from "./engine";
import type { Pool, Row } from "./pool";
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
/**
 * A draft of a row for a form (see `SyncEngine.draft`): the same draft
 * across renders, re-rendering when fields are set or the row changes in
 * the pool. Undefined until the pool has the row, and once it is deleted.
 *
 *   const issue = useDraft<Issue>("issues", id)
 *   <input value={issue.title} onChange={(e) => (issue.title = e.target.value)} />
 *   <button disabled={!issue.isDirty} onClick={() => issue.save()}>Save</button>
 */
export declare function useDraft<T extends Row = Row>(model: string, id: string): Draft<T> | undefined;
