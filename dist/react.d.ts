import { type Draft } from "./draft";
import { type SyncEngine } from "./engine";
import type { Pool } from "./pool";
import type { ModelName, QuerySpec, RowOf } from "./types";
export declare function setEngine(e: SyncEngine): void;
export declare function getEngine(): SyncEngine;
export declare const hasEngine: () => boolean;
/**
 * A view of the pool: `compute(pool, key)`, recomputed only when one of
 * `models` changed, so the same key gives the same object until then.
 * ponytail: views scan whole models; add indexes by foreign key once a
 * model holds tens of thousands of rows.
 */
export declare function view<T>(models: readonly ModelName[], compute: (pool: Pool, key: string) => T): (key?: string) => T;
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
 *   const issue = useDraft("issues", id) // Draft<Issue>
 *   <input value={issue.title} onChange={(e) => (issue.title = e.target.value)} />
 *   <button disabled={!issue.isDirty} onClick={() => issue.save()}>Save</button>
 */
export declare function useDraft<M extends ModelName>(model: M, id: string): Draft<RowOf<M>> | undefined;
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
export declare function useQuery<M extends ModelName>(spec: QuerySpec<M>): RowOf<M>[] | undefined;
/**
 * `useQuery` below a `<SyncGate>`: suspends until the first fetch instead
 * of returning undefined. A failed first fetch goes to the error boundary.
 */
export declare function useLoadedQuery<M extends ModelName>(spec: QuerySpec<M>): RowOf<M>[];
