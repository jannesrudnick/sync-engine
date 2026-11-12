import type { SupabaseClient } from "@supabase/supabase-js";
import type { EngineConfig } from "./engine";
import type { Columns } from "./types";
/**
 * Models, bootstrap, delta, realtime and queries for a Supabase project
 * with the `sync_actions` table of `schema.sql`. `columns` lists per table
 * the columns its trigger records; RLS decides which rows the user gets.
 */
export declare function supabaseSource(sb: SupabaseClient<any, any, any>, columns: Columns): Pick<EngineConfig, "models" | "bootstrap" | "delta" | "subscribe" | "query">;
/**
 * The newest sync id the user can see, for the server's answer to a batch
 * of transactions (see `EngineConfig.send`).
 */
export declare function lastSyncId(sb: SupabaseClient<any, any, any>): Promise<number>;
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
export declare function runDraftMutation(sb: SupabaseClient<any, any, any>, { name, args }: {
    name: string;
    args: unknown[];
}, options: {
    /** Per model the columns a draft may write, e.g. the `COLUMNS` of `supabaseSource`. */
    columns: Columns;
    /** Set as `user_id` of created rows. */
    userId: string;
    /** Models whose delete sets `deleted_at` instead of deleting the row. */
    softDelete?: readonly string[];
}): Promise<{
    error?: string;
} | null>;
