import type { SupabaseClient } from "@supabase/supabase-js";
import type { EngineConfig } from "./engine";
/**
 * Bootstrap, delta and realtime for a Supabase project with the
 * `sync_actions` table of `schema.sql`. `columns` lists per table the columns
 * its trigger records; RLS decides which rows the user gets.
 */
export declare function supabaseSource(sb: SupabaseClient<any, any, any>, columns: Record<string, readonly string[]>): Pick<EngineConfig, "bootstrap" | "delta" | "subscribe">;
/**
 * The newest sync id the user can see, for the server's answer to a batch
 * of transactions (see `EngineConfig.send`).
 */
export declare function lastSyncId(sb: SupabaseClient<any, any, any>): Promise<number>;
