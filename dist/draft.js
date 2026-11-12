/**
 * Drafts, after Linear's models: a row you assign fields on and then
 * `save()`. Saving is an ordinary transaction (`SyncEngine.commit`) with a
 * generic server mutation, so the optimistic update, the queue in IndexedDB,
 * rollback and rebase all work as for any other edit.
 *
 * - Fields you have not set read through to the pool, so a draft shows
 *   what other tabs and users change in the meantime.
 * - `save()` sends only the fields that differ from the pool now, as a
 *   patch: two people editing different fields of a row both win.
 * - A draft from `SyncEngine.create` is new: it is not in the pool until
 *   `save()`, which inserts it.
 *
 * The server runs the mutations of `DRAFT_MUTATIONS`; `runDraftMutation`
 * (Supabase) does that for the tables you allow.
 */
/** The server mutations a draft sends. Args: `[model, id, fields]`, `[model, id]` for delete. */
export const DRAFT_MUTATIONS = {
    create: "sync.create",
    update: "sync.update",
    delete: "sync.delete",
};
const RESERVED = new Set(["save", "delete", "discard", "isDirty", "isNew"]);
const states = new WeakMap();
export function makeDraft(engine, model, id, isNew, fields = {}) {
    if (!engine.pool.models.includes(model))
        throw new Error(`Unknown model "${model}".`);
    // The draft mutations are not among the app's registered ones.
    const commit = engine.commit;
    const state = {
        changes: {},
        isNew,
        version: 0,
        listeners: new Set(),
    };
    const current = () => state.isNew
        ? undefined
        : engine.pool.get(model, id);
    const changed = () => {
        state.version++;
        for (const l of state.listeners)
            l();
    };
    const dirtyPatch = () => {
        const row = current();
        const patch = {};
        for (const [k, v] of Object.entries(state.changes))
            if (!row || !same(row[k], v))
                patch[k] = v;
        return patch;
    };
    const methods = {
        save() {
            if (state.isNew) {
                const values = state.changes;
                const row = { ...values, id };
                state.isNew = false;
                state.changes = {};
                changed();
                return commit.call(engine, DRAFT_MUTATIONS.create, [model, id, values], [
                    { model, id, op: "set", row },
                ]);
            }
            const patch = dirtyPatch();
            state.changes = {};
            changed();
            if (!Object.keys(patch).length)
                return Promise.resolve(undefined);
            if (!current())
                return Promise.resolve(`The ${model} row ${id} no longer exists.`);
            return commit.call(engine, DRAFT_MUTATIONS.update, [model, id, patch], [
                { model, id, op: "patch", patch },
            ]);
        },
        delete() {
            const wasNew = state.isNew;
            state.changes = {};
            changed();
            if (wasNew)
                return Promise.resolve(undefined);
            return commit.call(engine, DRAFT_MUTATIONS.delete, [model, id], [
                { model, id, op: "delete" },
            ]);
        },
        discard() {
            state.changes = {};
            changed();
        },
        get isDirty() {
            return state.isNew
                ? true
                : Object.keys(dirtyPatch()).length > 0;
        },
        get isNew() {
            return state.isNew;
        },
    };
    const keys = () => Array.from(new Set(["id", ...Object.keys(current() ?? {}), ...Object.keys(state.changes)]));
    const proxy = new Proxy({}, {
        get(_, key) {
            if (typeof key === "symbol")
                return undefined;
            if (RESERVED.has(key))
                return Reflect.get(methods, key, methods);
            if (key === "id")
                return id;
            if (key in state.changes)
                return state.changes[key];
            return current()?.[key];
        },
        set(_, key, value) {
            if (typeof key === "symbol" || RESERVED.has(key) || key === "id")
                throw new Error(`Cannot set "${String(key)}" on a draft.`);
            state.changes[key] = value;
            changed();
            return true;
        },
        has(_, key) {
            return typeof key === "string" && (RESERVED.has(key) || keys().includes(key));
        },
        ownKeys: () => keys(),
        getOwnPropertyDescriptor(_, key) {
            if (typeof key !== "string" || !keys().includes(key))
                return undefined;
            return {
                value: proxy[key],
                writable: key !== "id",
                enumerable: true,
                configurable: true,
            };
        },
        deleteProperty() {
            throw new Error("Set a field to null instead of deleting it.");
        },
    });
    states.set(proxy, state);
    for (const [k, v] of Object.entries(fields))
        if (k !== "id")
            proxy[k] = v;
    return proxy;
}
/** For `useDraft`: calls `listener` when fields are set or saved. */
export function onDraftChange(draft, listener) {
    const state = states.get(draft);
    if (!state)
        return () => { };
    state.listeners.add(listener);
    return () => void state.listeners.delete(listener);
}
/** For `useDraft`: grows with every change of the draft. */
export function draftVersion(draft) {
    return states.get(draft)?.version ?? 0;
}
/** Equal values, also for jsonb columns (objects, arrays). */
function same(a, b) {
    if (Object.is(a, b))
        return true;
    if (typeof a !== "object" || typeof b !== "object" || !a || !b)
        return false;
    return JSON.stringify(a) === JSON.stringify(b);
}
