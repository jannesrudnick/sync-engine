import { makeDraft } from "./draft";
import { deleteOthers, getAll, openDb, write } from "./idb";
import { Pool } from "./pool";
const META = "_meta";
const QUERY_PREFIX = "query:";
/** Fetches of a query whose rows came back older than the pool. */
const QUERY_ATTEMPTS = 3;
const TRANSACTIONS = "_transactions";
const DELTA_LIMIT = 1000;
/** Transactions per request; the rest go in the next one. */
export const BATCH_LIMIT = 100;
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];
export class SyncEngine {
    config;
    pool;
    /** Resolves once the pool holds data (from IndexedDB or a bootstrap). */
    ready;
    isReady = false;
    db = null;
    lastSyncId = 0;
    tab = crypto.randomUUID();
    transactions = [];
    waiting = new Map();
    sending = false;
    retries = 0;
    retryTimer;
    catchingUp = null;
    catchUpAgain = false;
    cleanup = [];
    queries = new Map();
    refetchTimer;
    constructor(config) {
        this.config = config;
        this.pool = new Pool(config.models);
        let markReady;
        this.ready = new Promise((resolve) => (markReady = resolve));
        void this.start().then(() => {
            this.isReady = true;
            this.pool.touch();
            markReady();
        });
    }
    /**
     * Makes an edit: applies `changes` to the pool now and sends the server
     * mutation `name(...args)` behind it. Resolves to the error message once
     * it failed (and was rolled back), or undefined once the server ran it.
     */
    commit(name, args, changes) {
        const tx = {
            id: crypto.randomUUID(),
            tab: this.tab,
            name,
            args,
            changes,
        };
        this.transactions.push(tx);
        this.pool.push(tx.id, changes);
        void this.store([tx]);
        const result = new Promise((resolve) => this.waiting.set(tx.id, resolve));
        queueMicrotask(() => void this.flush());
        return result;
    }
    /**
     * A draft of a row in the pool: assign fields, then `save()` (see
     * `draft.ts`). Throws when the pool has no such row.
     */
    draft(model, id) {
        if (!this.pool.get(model, id))
            throw new Error(`No ${model} row ${id} in the pool.`);
        return makeDraft(this, model, id, false);
    }
    /**
     * A new row as a draft: not in the pool until `save()` inserts it. The id
     * is `fields.id` or a new UUID.
     */
    create(model, fields = {}) {
        const id = typeof fields.id === "string" ? fields.id : crypto.randomUUID();
        return makeDraft(this, model, id, true, fields);
    }
    /**
     * The rows of a query (see `QuerySpec`), from the pool; the same array
     * until they change. Undefined until it was fetched once (here or in an
     * earlier visit): call `loadQuery` or `watchQuery` to fetch it.
     */
    queryRows(spec) {
        const state = this.queries.get(queryKey(spec));
        if (!state?.ids)
            return undefined;
        const at = `${this.pool.version(spec.model)}:${state.version}`;
        if (state.cache?.at === at)
            return state.cache.rows;
        let rows;
        if (spec.filter)
            rows = this.pool.rows(spec.model).filter(spec.filter);
        else {
            rows = [];
            for (const id of state.ids) {
                const row = this.pool.get(spec.model, id);
                if (row)
                    rows.push(row);
            }
        }
        if (spec.sort)
            rows = [...rows].sort(spec.sort);
        state.cache = { at, rows: rows };
        return rows;
    }
    /**
     * Fetches a query and adds its rows to the pool. One fetch per query at a
     * time: a call while one runs gets that one. Rejects when it fails and
     * the query has no rows from before.
     */
    loadQuery(spec) {
        const state = this.queryState(spec);
        state.loading ??= this.fetchQuery(state, spec)
            .catch((e) => {
            // Offline: the rows from before stay.
            if (!state.ids)
                throw e;
            console.error("sync query failed", e);
        })
            .finally(() => {
            state.loading = null;
        });
        return state.loading;
    }
    /**
     * Keeps a query fresh while it is shown: fetches it now and, for a query
     * without `filter`, again whenever its model changes. Returns the stop.
     */
    watchQuery(spec) {
        const state = this.queryState(spec);
        state.watchers++;
        this.loadQuery(spec).catch((e) => console.error("sync query failed", e));
        return () => void state.watchers--;
    }
    /** Fetches what changed on the server now (e.g. after a server action). */
    sync() {
        return this.catchUp();
    }
    /** Whether edits are waiting to be sent or confirmed. */
    get pending() {
        return this.transactions.length > 0;
    }
    /** The IndexedDB name. */
    get name() {
        return this.config.name;
    }
    stop() {
        clearTimeout(this.retryTimer);
        clearTimeout(this.refetchTimer);
        for (const c of this.cleanup)
            c();
        this.db?.close();
    }
    async start() {
        const { name, schemaVersion, models } = this.config;
        // Another user's cache has no business on this device.
        void deleteOthers(name.slice(0, name.lastIndexOf(":") + 1), name).catch(() => { });
        this.holdTabLock();
        try {
            this.db = await openDb(name, schemaVersion, [
                ...models,
                META,
                TRANSACTIONS,
            ]);
        }
        catch {
            // Private mode or blocked storage: run from memory only.
            this.db = null;
        }
        const cached = await this.readCache().catch(() => null);
        if (cached) {
            this.pool.load(cached.rows);
            this.lastSyncId = cached.lastSyncId;
            for (const { key, ids } of cached.queries)
                Object.assign(this.queryState(null, key), { ids: new Set(ids) });
            await this.adopt(cached.transactions);
            this.subscribe();
            void this.catchUp();
        }
        else {
            await this.bootstrap();
            this.subscribe();
        }
        void this.flush();
    }
    async readCache() {
        const db = this.db;
        if (!db)
            return null;
        const records = await getAll(db, META);
        const meta = records.find((r) => r.id === "meta");
        // Written with the bootstrap: without it the stores are not complete.
        if (!meta)
            return null;
        const queries = records
            .filter((r) => r.id.startsWith(QUERY_PREFIX))
            .map((r) => ({
            key: r.id.slice(QUERY_PREFIX.length),
            ids: r.ids,
        }));
        const rows = {};
        await Promise.all(this.config.models.map(async (m) => (rows[m] = await getAll(db, m))));
        const transactions = await getAll(db, TRANSACTIONS);
        return { lastSyncId: meta.lastSyncId, rows, transactions, queries };
    }
    /**
     * Takes over stored transactions whose tab is gone (reloaded or closed).
     * Those of tabs still open stay theirs.
     */
    async adopt(stored) {
        const held = new Set(((await navigator.locks?.query())?.held ?? []).map((l) => l.name));
        const mine = stored.filter((tx) => !held.has(lockName(tx.tab)));
        for (const tx of mine) {
            tx.tab = this.tab;
            this.transactions.push(tx);
            this.pool.push(tx.id, tx.changes);
        }
        await this.store(mine);
    }
    /** Held as long as this tab lives, so other tabs know it is open. */
    holdTabLock() {
        void navigator.locks?.request(lockName(this.tab), () => new Promise(() => { }));
    }
    async bootstrap() {
        // Retried until it works: without it there is nothing to show.
        for (let attempt = 0;; attempt++) {
            try {
                const lazy = this.config.lazy ?? [];
                const { lastSyncId, rows } = await this.config.bootstrap(this.config.models.filter((m) => !lazy.includes(m)));
                this.pool.load(rows);
                this.lastSyncId = lastSyncId;
                await this.persistAll(rows);
                return;
            }
            catch (e) {
                console.error("sync bootstrap failed", e);
                await sleep(RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]);
            }
        }
    }
    subscribe() {
        let timer;
        const poke = () => {
            clearTimeout(timer);
            timer = setTimeout(() => void this.catchUp(), 50);
        };
        const online = () => {
            poke();
            void this.flush();
        };
        const visible = () => document.visibilityState === "visible" && online();
        window.addEventListener("online", online);
        document.addEventListener("visibilitychange", visible);
        const unsubscribe = this.config.subscribe(poke);
        this.cleanup.push(() => {
            clearTimeout(timer);
            unsubscribe();
            window.removeEventListener("online", online);
            document.removeEventListener("visibilitychange", visible);
        });
    }
    /** Applies every sync action after `lastSyncId`; one run at a time. */
    catchUp() {
        if (this.catchingUp) {
            this.catchUpAgain = true;
            return this.catchingUp;
        }
        this.catchingUp = (async () => {
            try {
                do {
                    this.catchUpAgain = false;
                    for (;;) {
                        const actions = await this.config.delta(this.lastSyncId, DELTA_LIMIT);
                        if (actions.length)
                            await this.applyActions(actions);
                        if (actions.length < DELTA_LIMIT)
                            break;
                    }
                } while (this.catchUpAgain);
            }
            catch (e) {
                // The next poke (realtime, focus, online) tries again.
                console.error("sync catch-up failed", e);
            }
            finally {
                this.catchingUp = null;
            }
        })();
        return this.catchingUp;
    }
    async applyActions(actions) {
        const touched = this.pool.apply(actions);
        this.lastSyncId = actions.at(-1).id;
        this.completeConfirmed();
        this.refetchQueries(touched.keys());
        const db = this.db;
        if (!db)
            return;
        await write(db, [...touched.keys(), META], (store) => {
            for (const [model, ids] of touched)
                for (const id of ids) {
                    const row = this.pool.baseRow(model, id);
                    if (row)
                        store(model).put(row);
                    else
                        store(model).delete(id);
                }
            store(META).put({ id: "meta", lastSyncId: this.lastSyncId });
        }).catch((e) => console.error("sync cache write failed", e));
    }
    /** Drops the transactions whose effect has arrived as a sync action. */
    completeConfirmed() {
        const done = this.transactions.filter((tx) => tx.syncId !== undefined && tx.syncId <= this.lastSyncId);
        if (!done.length)
            return;
        this.transactions = this.transactions.filter((tx) => !done.includes(tx));
        for (const tx of done)
            this.pool.drop(tx.id);
        void this.unstore(done);
    }
    /** Sends the transactions not sent yet, in order, as batches. */
    async flush() {
        if (this.sending)
            return;
        const batch = this.transactions
            .filter((tx) => tx.syncId === undefined && tx.tab === this.tab)
            .slice(0, BATCH_LIMIT);
        if (!batch.length)
            return;
        this.sending = true;
        let results;
        try {
            results = await this.config.send(batch.map(({ name, args }) => ({ name, args })));
            this.retries = 0;
        }
        catch {
            // Offline or the server is down: the batch stays and goes again later.
            this.sending = false;
            const delay = RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)];
            clearTimeout(this.retryTimer);
            this.retryTimer = setTimeout(() => void this.flush(), delay);
            return;
        }
        this.sending = false;
        const failed = [];
        batch.forEach((tx, i) => {
            const { error, syncId } = results[i] ?? { error: "Keine Antwort." };
            const resolve = this.waiting.get(tx.id);
            this.waiting.delete(tx.id);
            if (error) {
                failed.push(tx);
                this.pool.drop(tx.id);
                if (resolve)
                    resolve(error);
                else
                    this.config.onError(tx.name, error);
            }
            else {
                tx.syncId = syncId;
                resolve?.(undefined);
            }
        });
        this.transactions = this.transactions.filter((tx) => !failed.includes(tx));
        void this.unstore(failed);
        void this.store(batch.filter((tx) => !failed.includes(tx)));
        this.completeConfirmed();
        if (this.transactions.some((tx) => tx.syncId !== undefined))
            void this.catchUp();
        // The rest of the queue, and edits made while this batch was on its way.
        void this.flush();
    }
    queryState(spec, key = queryKey(spec)) {
        let state = this.queries.get(key);
        if (!state) {
            state = { ids: null, version: 0, watchers: 0, loading: null, spec: null };
            this.queries.set(key, state);
        }
        state.spec ??= spec;
        return state;
    }
    async fetchQuery(state, spec) {
        if (!this.config.query)
            throw new Error("EngineConfig.query is missing.");
        // Before the pool is loaded, `merge` cannot tell which rows it has.
        await this.ready;
        let result;
        for (let attempt = 1;; attempt++) {
            result = await this.config.query(spec.model, spec.source, spec.params ?? {});
            // Rows older than the pool could bring back one it has seen deleted
            // since; fetch again (the next one is newer).
            if (result.syncId >= this.lastSyncId || attempt === QUERY_ATTEMPTS)
                break;
        }
        const added = this.pool.merge(spec.model, result.rows);
        state.ids = new Set(result.rows.map((r) => r.id));
        state.version++;
        this.pool.touch([spec.model]);
        const db = this.db;
        if (!db)
            return;
        await write(db, [spec.model, META], (store) => {
            for (const r of added)
                store(spec.model).put(r);
            store(META).put({
                id: QUERY_PREFIX + queryKey(spec),
                ids: Array.from(state.ids),
            });
        }).catch((e) => console.error("sync cache write failed", e));
    }
    /** Fetches the shown queries without `filter` of the models that changed. */
    refetchQueries(models) {
        const changed = new Set(models);
        const due = Array.from(this.queries.values()).filter((q) => q.watchers > 0 && q.spec && !q.spec.filter && changed.has(q.spec.model));
        if (!due.length)
            return;
        clearTimeout(this.refetchTimer);
        this.refetchTimer = setTimeout(() => {
            for (const q of due)
                this.loadQuery(q.spec).catch((e) => console.error("sync query failed", e));
        }, 300);
    }
    async persistAll(rows) {
        const db = this.db;
        if (!db)
            return;
        const models = this.config.models;
        await write(db, [...models, META], (store) => {
            for (const m of models) {
                store(m).clear();
                for (const r of rows[m] ?? [])
                    store(m).put(r);
            }
            store(META).put({ id: "meta", lastSyncId: this.lastSyncId });
        }).catch((e) => console.error("sync cache write failed", e));
    }
    async store(txs) {
        if (!this.db || !txs.length)
            return;
        await write(this.db, [TRANSACTIONS], (store) => {
            for (const tx of txs)
                store(TRANSACTIONS).put(tx);
        }).catch(() => { });
    }
    async unstore(txs) {
        if (!this.db || !txs.length)
            return;
        await write(this.db, [TRANSACTIONS], (store) => {
            for (const tx of txs)
                store(TRANSACTIONS).delete(tx.id);
        }).catch(() => { });
    }
}
const lockName = (tab) => `sync-tab:${tab}`;
/** A query's identity: model, source and params (in key order). */
export function queryKey(spec) {
    const params = Object.entries(spec.params ?? {}).sort(([a], [b]) => a < b ? -1 : 1);
    return JSON.stringify([spec.model, spec.source, params]);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
