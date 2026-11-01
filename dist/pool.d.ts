/**
 * The object pool: every row of every synced model, in memory.
 *
 * Two layers, like Linear's: `base` is what the server confirmed (bootstrap
 * plus sync actions), and the pending transactions are laid over it in
 * order. What views read (`get`, `rows`) is base with the pending changes
 * applied. A sync action for a row with a pending change rebases it: the new
 * server state goes into base and the change is applied on top again. A
 * transaction that fails is dropped and its rows fall back to base; one the
 * server confirmed is dropped once base has its effect.
 */
export type Row = {
    id: string;
} & Record<string, unknown>;
/** One optimistic change of a transaction. */
export type Change = {
    model: string;
    id: string;
    op: "set";
    row: Row;
} | {
    model: string;
    id: string;
    op: "patch";
    patch: Record<string, unknown>;
} | {
    model: string;
    id: string;
    op: "delete";
};
/** A server-side change, as `sync_actions` stores it. */
export type SyncAction = {
    id: number;
    model: string;
    model_id: string;
    action: "I" | "U" | "D";
    data: Row | null;
};
export declare class Pool {
    readonly models: readonly string[];
    private base;
    private visible;
    private layers;
    private versions;
    private arrays;
    private listeners;
    constructor(models: readonly string[]);
    get<T extends Row>(model: string, id: string): T | undefined;
    /** All rows of `model`; the same array until one of them changes. */
    rows<T extends Row>(model: string): T[];
    /** Grows with every change of `model`. */
    version(model: string): number;
    subscribe(listener: () => void): () => undefined;
    /** The server rows as they are now, e.g. from a bootstrap. */
    load(rows: Record<string, Row[]>): void;
    /** Applies server changes to base; returns the rows to store and delete. */
    apply(actions: SyncAction[]): Map<string, Set<string>>;
    /** The confirmed row, without pending changes. */
    baseRow(model: string, id: string): Row | undefined;
    /** Lays a transaction's changes over base. */
    push(key: string, changes: Change[]): void;
    /** Takes a transaction's changes off again (failed or confirmed). */
    drop(key: string): void;
    /** Tells every subscriber to read again (e.g. once the pool is ready). */
    touch(): void;
    private recompute;
    private recomputeAll;
    private notify;
}
