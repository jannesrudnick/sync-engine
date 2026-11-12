import { DRAFT_MUTATIONS } from "./draft";
// PostgREST returns at most `max_rows` rows per request (Supabase: 1000).
const PAGE_SIZE = 1000;
/**
 * Models, bootstrap, delta, realtime and queries for a Supabase project
 * with the `sync_actions` table of `schema.sql`. `columns` lists per table
 * the columns its trigger records; RLS decides which rows the user gets.
 */
export function supabaseSource(
// Any typed client: the engine reads tables by name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
sb, columns) {
    const cols = columns;
    /** Every row of `model` in `source` (its table by default) matching `params`. */
    async function all(model, source = model, params = {}) {
        const rows = [];
        for (let from = 0;; from += PAGE_SIZE) {
            let q = sb.from(source).select(cols[model].join(","));
            for (const [column, value] of Object.entries(params))
                q = value === null ? q.is(column, null) : q.eq(column, value);
            const { data, error } = await q
                .order("id")
                .range(from, from + PAGE_SIZE - 1);
            if (error)
                throw error;
            rows.push(...(data ?? []));
            if ((data?.length ?? 0) < PAGE_SIZE)
                return rows;
        }
    }
    return {
        models: Object.keys(columns),
        async bootstrap(models) {
            // The sync id first: changes made while the rows load come again as
            // sync actions, and applying them twice is harmless.
            const syncId = await newestSyncId(sb);
            const rows = {};
            await Promise.all(models.map(async (t) => (rows[t] = await all(t))));
            return { lastSyncId: syncId, rows };
        },
        async query(model, source, params) {
            // As for the bootstrap: the sync id first.
            const syncId = await newestSyncId(sb);
            return { syncId, rows: await all(model, source, params) };
        },
        async delta(syncId, limit) {
            const { data, error } = await sb
                .from("sync_actions")
                .select("id, model, model_id, action, data")
                .gt("id", syncId)
                .order("id")
                .limit(limit);
            if (error)
                throw error;
            return data;
        },
        subscribe(poke) {
            const channel = sb
                .channel("sync")
                .on("postgres_changes", { event: "INSERT", schema: "public", table: "sync_actions" }, poke)
                // Realtime does not replay what happened while it was disconnected.
                .subscribe((status) => status === "SUBSCRIBED" && poke());
            return () => void sb.removeChannel(channel);
        },
    };
}
/**
 * The newest sync id the user can see, for the server's answer to a batch
 * of transactions (see `EngineConfig.send`).
 */
export async function lastSyncId(
// eslint-disable-next-line @typescript-eslint/no-explicit-any
sb) {
    return newestSyncId(sb).catch(() => 0);
}
async function newestSyncId(
// eslint-disable-next-line @typescript-eslint/no-explicit-any
sb) {
    const { data, error } = await sb
        .from("sync_actions")
        .select("id")
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error)
        throw error;
    return data?.id ?? 0;
}
/**
 * Runs a mutation a draft sent (`DRAFT_MUTATIONS`) on the server; null for
 * any other mutation, which the app runs itself. For the batch of
 * `EngineConfig.send`:
 *
 *   for (const m of batch)
 *     results.push((await runDraftMutation(sb, m, { columns, userId })) ?? (await runOwn(m)))
 *
 * Only the models in `columns` and their listed columns can be written
 * (never `id` or `user_id`); RLS still decides which rows. Running a
 * mutation twice is harmless: a create of an existing id does nothing.
 */
export async function runDraftMutation(
// eslint-disable-next-line @typescript-eslint/no-explicit-any
sb, { name, args }, options) {
    const kinds = Object.values(DRAFT_MUTATIONS);
    if (!kinds.includes(name))
        return null;
    const [model, id, fields] = args;
    const allowed = options.columns[model];
    if (!allowed)
        return { error: `Unknown model "${model}".` };
    if (typeof id !== "string")
        return { error: "Missing id." };
    let values = {};
    if (name !== DRAFT_MUTATIONS.delete) {
        for (const [k, v] of Object.entries(fields ?? {})) {
            if (k === "id" || k === "user_id" || !allowed.includes(k))
                return { error: `The column "${k}" of ${model} cannot be written.` };
            values[k] = v;
        }
    }
    let result;
    if (name === DRAFT_MUTATIONS.create) {
        values = { ...values, id, user_id: options.userId };
        result = await sb
            .from(model)
            .upsert(values, { onConflict: "id", ignoreDuplicates: true });
    }
    else if (name === DRAFT_MUTATIONS.update) {
        result = await sb.from(model).update(values).eq("id", id).select("id");
        if (!result.error && !result.data?.length)
            return { error: `The ${model} row ${id} does not exist.` };
    }
    else if (options.softDelete?.includes(model)) {
        result = await sb
            .from(model)
            .update({ deleted_at: new Date().toISOString() })
            .eq("id", id);
    }
    else {
        result = await sb.from(model).delete().eq("id", id);
    }
    return result.error ? { error: result.error.message } : {};
}
