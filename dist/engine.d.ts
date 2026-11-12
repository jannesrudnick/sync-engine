import { type Draft } from "./draft";
import { Pool, type SyncAction } from "./pool";
import type { Change, FieldsOf, ModelName, MutationArgs, MutationName, QuerySpec, Row, RowOf } from "./types";
/**
 * A sync engine after Linear's (see README.md):
 *
 * - All of a user's rows live in the object pool and in IndexedDB. A start
 *   renders from IndexedDB at once and catches up from the last sync id it
 *   has; only the very first start (or a new schema) waits for a bootstrap.
 * - The server numbers every change (`sync_actions`). Realtime pokes the
 *   engine, which fetches everything after its last sync id, in order.
 * - Edits are transactions: their changes show in the pool in the same
 *   tick, they are stored in IndexedDB and sent in batches, in order. A
 *   failed one is rolled back; a confirmed one stays laid over the pool
 *   until the sync action carrying its effect has arrived, so nothing
 *   flickers back. Transactions survive a reload or a lost connection and
 *   are sent later; a tab sends its own, and those of tabs that were closed.
 *
 * - Lazy models are not bootstrapped: queries (`queryRows`) load the rows
 *   a screen needs from a server view. Sync actions keep loaded rows
 *   current, as for any other model.
 *
 * This file knows nothing of the app: the models and how to talk to the
 * server come in through `EngineConfig`.
 */
/** What the engine needs from the app. */
export type EngineConfig = {
    /** IndexedDB name; one database per user. */
    name: string;
    /** Bump to drop the local cache (new models or columns). */
    schemaVersion: number;
    models: readonly ModelName[];
    /** Models loaded only by queries, not by the bootstrap. */
    lazy?: readonly ModelName[];
    /** Every row of `models` the user may read, and the sync id they are as of. */
    bootstrap(models: readonly ModelName[]): Promise<{
        lastSyncId: number;
        rows: Record<string, Row[]>;
    }>;
    /**
     * The rows of `model` that `source` returns for `params` (column = value),
     * and a sync id they are at least as new as (read before the rows).
     */
    query?(model: ModelName, source: string, params: Record<string, unknown>): Promise<{
        syncId: number;
        rows: Row[];
    }>;
    /** Sync actions after `syncId`, oldest first, at most `limit`. */
    delta(syncId: number, limit: number): Promise<SyncAction[]>;
    /** Calls `poke` when there may be new sync actions; returns the unsubscribe. */
    subscribe(poke: () => void): () => void;
    /**
     * Sends transactions to the server, which runs them in order. Throws when
     * the server could not be reached (they are sent again later).
     */
    send(batch: {
        name: string;
        args: unknown[];
    }[]): Promise<{
        error?: string;
        syncId: number;
    }[]>;
    /** A transaction failed that no caller waits for (e.g. sent after a reload). */
    onError(name: string, error: string): void;
};
/** Transactions per request; the rest go in the next one. */
export declare const BATCH_LIMIT = 100;
export declare class SyncEngine {
    private config;
    readonly pool: Pool;
    /** Resolves once the pool holds data (from IndexedDB or a bootstrap). */
    readonly ready: Promise<void>;
    isReady: boolean;
    private db;
    private lastSyncId;
    private tab;
    private transactions;
    private waiting;
    private sending;
    private retries;
    private retryTimer;
    private catchingUp;
    private catchUpAgain;
    private cleanup;
    private queries;
    private refetchTimer;
    constructor(config: EngineConfig);
    /**
     * Makes an edit: applies `changes` to the pool now and sends the server
     * mutation `name(...args)` behind it. Resolves to the error message once
     * it failed (and was rolled back), or undefined once the server ran it.
     */
    commit<N extends MutationName>(name: N, args: MutationArgs<N>, changes: Change[]): Promise<string | undefined>;
    /**
     * A draft of a row in the pool: assign fields, then `save()` (see
     * `draft.ts`). Throws when the pool has no such row.
     */
    draft<M extends ModelName>(model: M, id: string): Draft<RowOf<M>>;
    /**
     * A new row as a draft: not in the pool until `save()` inserts it. The id
     * is `fields.id` or a new UUID.
     */
    create<M extends ModelName>(model: M, fields?: Partial<FieldsOf<M>> & {
        id?: string;
    }): Draft<RowOf<M>>;
    /**
     * The rows of a query (see `QuerySpec`), from the pool; the same array
     * until they change. Undefined until it was fetched once (here or in an
     * earlier visit): call `loadQuery` or `watchQuery` to fetch it.
     */
    queryRows<M extends ModelName>(spec: QuerySpec<M>): RowOf<M>[] | undefined;
    /**
     * Fetches a query and adds its rows to the pool. One fetch per query at a
     * time: a call while one runs gets that one. Rejects when it fails and
     * the query has no rows from before.
     */
    loadQuery<M extends ModelName>(spec: QuerySpec<M>): Promise<void>;
    /**
     * Keeps a query fresh while it is shown: fetches it now and, for a query
     * without `filter`, again whenever its model changes. Returns the stop.
     */
    watchQuery<M extends ModelName>(spec: QuerySpec<M>): () => undefined;
    /** Fetches what changed on the server now (e.g. after a server action). */
    sync(): Promise<void>;
    /** Whether edits are waiting to be sent or confirmed. */
    get pending(): boolean;
    /** The IndexedDB name. */
    get name(): string;
    stop(): void;
    private start;
    private readCache;
    /**
     * Takes over stored transactions whose tab is gone (reloaded or closed).
     * Those of tabs still open stay theirs.
     */
    private adopt;
    /** Held as long as this tab lives, so other tabs know it is open. */
    private holdTabLock;
    private bootstrap;
    private subscribe;
    /** Applies every sync action after `lastSyncId`; one run at a time. */
    private catchUp;
    private applyActions;
    /** Drops the transactions whose effect has arrived as a sync action. */
    private completeConfirmed;
    /** Sends the transactions not sent yet, in order, as batches. */
    private flush;
    private queryState;
    private fetchQuery;
    /** Fetches the shown queries without `filter` of the models that changed. */
    private refetchQueries;
    private persistAll;
    private store;
    private unstore;
}
/** A query's identity: model, source and params (in key order). */
export declare function queryKey(spec: QuerySpec<ModelName>): string;
