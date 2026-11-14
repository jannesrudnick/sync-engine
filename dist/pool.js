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
export class Pool {
    models;
    base = new Map();
    visible = new Map();
    layers = [];
    /** Unsaved edits: model → id → the fields a draft assigned. */
    unsaved = new Map();
    versions = new Map();
    arrays = new Map();
    listeners = new Set();
    constructor(models) {
        this.models = models;
        for (const m of models) {
            this.base.set(m, new Map());
            this.visible.set(m, new Map());
            this.versions.set(m, 0);
        }
    }
    get(model, id) {
        return this.visible.get(model)?.get(id);
    }
    /** All rows of `model`; the same array until one of them changes. */
    rows(model) {
        const version = this.version(model);
        const cached = this.arrays.get(model);
        if (cached?.version === version)
            return cached.rows;
        const rows = Array.from(this.visible.get(model).values());
        this.arrays.set(model, { version, rows });
        return rows;
    }
    /** Grows with every change of `model`. */
    version(model) {
        return this.versions.get(model) ?? 0;
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
    }
    /** The server rows as they are now, e.g. from a bootstrap. */
    load(rows) {
        for (const m of this.models) {
            const map = new Map();
            for (const r of rows[m] ?? [])
                map.set(r.id, r);
            this.base.set(m, map);
        }
        this.recomputeAll();
    }
    /** Applies server changes to base; returns the rows to store and delete. */
    apply(actions) {
        const touched = new Map();
        for (const a of actions) {
            const map = this.base.get(a.model);
            if (!map)
                continue;
            if (a.action === "D" || !a.data)
                map.delete(a.model_id);
            else
                map.set(a.model_id, a.data);
            if (!touched.has(a.model))
                touched.set(a.model, new Set());
            touched.get(a.model).add(a.model_id);
        }
        for (const [model, ids] of touched)
            for (const id of ids)
                this.recompute(model, id);
        this.notify(touched.keys());
        return touched;
    }
    /**
     * Adds server rows the pool does not have yet (from a query) and returns
     * them. Rows it has are kept: sync actions keep them current, so they are
     * at least as new.
     */
    merge(model, rows) {
        const map = this.base.get(model);
        if (!map)
            return [];
        const added = rows.filter((r) => !map.has(r.id));
        for (const r of added) {
            map.set(r.id, r);
            this.recompute(model, r.id);
        }
        if (added.length)
            this.notify([model]);
        return added;
    }
    /** The confirmed row, without pending changes. */
    baseRow(model, id) {
        return this.base.get(model)?.get(id);
    }
    /**
     * The row as saved: base with the pending transactions, without unsaved
     * edits. A draft saves the fields that differ from it.
     */
    saved(model, id) {
        let row = this.base.get(model)?.get(id);
        for (const { changes } of this.layers)
            for (const c of changes) {
                if (c.model !== model || c.id !== id)
                    continue;
                if (c.op === "set")
                    row = c.row;
                else if (c.op === "delete")
                    row = undefined;
                else if (row)
                    row = { ...row, ...c.patch };
            }
        return row;
    }
    /**
     * Sets a row's unsaved edits (a draft's assigned fields), shown on top of
     * everything; null takes them off (saved or discarded).
     */
    setUnsaved(model, id, fields) {
        let rows = this.unsaved.get(model);
        if (!rows)
            this.unsaved.set(model, (rows = new Map()));
        if (fields && Object.keys(fields).length)
            rows.set(id, fields);
        else if (!rows.delete(id))
            return;
        this.recompute(model, id);
        this.notify([model]);
    }
    /** Lays a transaction's changes over base. */
    push(key, changes) {
        this.layers.push({ key, changes: changes });
        for (const c of changes)
            this.recompute(c.model, c.id);
        this.notify(changes.map((c) => c.model));
    }
    /** Takes a transaction's changes off again (failed or confirmed). */
    drop(key) {
        const layer = this.layers.find((l) => l.key === key);
        if (!layer)
            return;
        this.layers = this.layers.filter((l) => l !== layer);
        for (const c of layer.changes)
            this.recompute(c.model, c.id);
        this.notify(layer.changes.map((c) => c.model));
    }
    /** Tells every subscriber to read again (e.g. once the pool is ready). */
    touch(models = this.models) {
        this.notify(models);
    }
    recompute(model, id) {
        let row = this.saved(model, id);
        const edits = this.unsaved.get(model)?.get(id);
        if (row && edits)
            row = { ...row, ...edits };
        const visible = this.visible.get(model);
        if (!visible)
            return;
        if (row)
            visible.set(id, row);
        else
            visible.delete(id);
    }
    recomputeAll() {
        for (const m of this.models) {
            this.visible.set(m, new Map(this.base.get(m)));
            for (const { changes } of this.layers)
                for (const c of changes)
                    if (c.model === m)
                        this.recompute(m, c.id);
            for (const id of this.unsaved.get(m)?.keys() ?? [])
                this.recompute(m, id);
        }
        this.notify(this.models);
    }
    notify(models) {
        for (const m of new Set(models))
            this.versions.set(m, (this.versions.get(m) ?? 0) + 1);
        for (const l of this.listeners)
            l();
    }
}
