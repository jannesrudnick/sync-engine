// PostgREST returns at most `max_rows` rows per request (Supabase: 1000).
const PAGE_SIZE = 1000;
/**
 * Bootstrap, delta and realtime for a Supabase project with the
 * `sync_actions` table of `schema.sql`. `columns` lists per table the columns
 * its trigger records; RLS decides which rows the user gets.
 */
export function supabaseSource(
// Any typed client: the engine reads tables by name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
sb, columns) {
    async function all(table) {
        const rows = [];
        for (let from = 0;; from += PAGE_SIZE) {
            const { data, error } = await sb
                .from(table)
                .select(columns[table].join(","))
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
        async bootstrap() {
            // The sync id first: changes made while the rows load come again as
            // sync actions, and applying them twice is harmless.
            const { data: last, error } = await sb
                .from("sync_actions")
                .select("id")
                .order("id", { ascending: false })
                .limit(1)
                .maybeSingle();
            if (error)
                throw error;
            const rows = {};
            await Promise.all(Object.keys(columns).map(async (t) => (rows[t] = await all(t))));
            return { lastSyncId: last?.id ?? 0, rows };
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
    const { data } = await sb
        .from("sync_actions")
        .select("id")
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();
    return data?.id ?? 0;
}
