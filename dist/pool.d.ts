/**
 * The object pool: every row of every synced model, in memory.
 *
 * Three layers, like Linear's: `base` is what the server confirmed
 * (bootstrap plus sync actions), the pending transactions are laid over it
 * in order, and on top are the unsaved edits of drafts (fields assigned but
 * not saved yet). What views read (`get`, `rows`) is all three, so an edit
 * shows everywhere the moment a field is assigned. A sync action for a row with a pending change rebases it: the new
 * server state goes into base and the change is applied on top again. A
 * transaction that fails is dropped and its rows fall back to base; one the
 * server confirmed is dropped once base has its effect.
 */
import type { Change, ModelName, Row, RowOf } from "./types";
export type { Change, Row };
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
    /** Unsaved edits: model → id → the fields a draft assigned. */
    private unsaved;
    private versions;
    private arrays;
    private listeners;
    constructor(models: readonly string[]);
    get<M extends ModelName>(model: M, id: string): RowOf<M> | undefined;
    /** All rows of `model`; the same array until one of them changes. */
    rows<M extends ModelName>(model: M): RowOf<M>[];
    /** Grows with every change of `model`. */
    version(model: string): number;
    subscribe(listener: () => void): () => undefined;
    /** The server rows as they are now, e.g. from a bootstrap. */
    load(rows: Record<string, Row[]>): void;
    /** Applies server changes to base; returns the rows to store and delete. */
    apply(actions: SyncAction[]): Map<string, Set<string>>;
    /**
     * Adds server rows the pool does not have yet (from a query) and returns
     * them. Rows it has are kept: sync actions keep them current, so they are
     * at least as new.
     */
    merge(model: string, rows: Row[]): Row[];
    /** The confirmed row, without pending changes. */
    baseRow(model: string, id: string): Row | undefined;
    /**
     * The row as saved: base with the pending transactions, without unsaved
     * edits. A draft saves the fields that differ from it.
     */
    saved(model: string, id: string): Row | undefined;
    /**
     * Sets a row's unsaved edits (a draft's assigned fields), shown on top of
     * everything; null takes them off (saved or discarded).
     */
    setUnsaved(model: string, id: string, fields: Record<string, unknown> | null): void;
    /** Lays a transaction's changes over base. */
    push(key: string, changes: Change[]): void;
    /** Takes a transaction's changes off again (failed or confirmed). */
    drop(key: string): void;
    /** Tells every subscriber to read again (e.g. once the pool is ready). */
    touch(models?: Iterable<string>): void;
    private recompute;
    private recomputeAll;
    private notify;
}
