import type { SupabaseClient } from "@supabase/supabase-js"

import { DRAFT_MUTATIONS } from "./draft"
import type { EngineConfig } from "./engine"
import type { Row, SyncAction } from "./pool"

// PostgREST returns at most `max_rows` rows per request (Supabase: 1000).
const PAGE_SIZE = 1000

/**
 * Bootstrap, delta and realtime for a Supabase project with the
 * `sync_actions` table of `schema.sql`. `columns` lists per table the columns
 * its trigger records; RLS decides which rows the user gets.
 */
export function supabaseSource(
  // Any typed client: the engine reads tables by name.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: SupabaseClient<any, any, any>,
  columns: Record<string, readonly string[]>
): Pick<EngineConfig, "bootstrap" | "delta" | "subscribe"> {
  async function all(table: string) {
    const rows: Row[] = []
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await sb
        .from(table)
        .select(columns[table].join(","))
        .order("id")
        .range(from, from + PAGE_SIZE - 1)
      if (error) throw error
      rows.push(...((data ?? []) as unknown as Row[]))
      if ((data?.length ?? 0) < PAGE_SIZE) return rows
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
        .maybeSingle()
      if (error) throw error
      const rows: Record<string, Row[]> = {}
      await Promise.all(
        Object.keys(columns).map(async (t) => (rows[t] = await all(t)))
      )
      return { lastSyncId: (last as { id: number } | null)?.id ?? 0, rows }
    },

    async delta(syncId, limit) {
      const { data, error } = await sb
        .from("sync_actions")
        .select("id, model, model_id, action, data")
        .gt("id", syncId)
        .order("id")
        .limit(limit)
      if (error) throw error
      return data as SyncAction[]
    },

    subscribe(poke) {
      const channel = sb
        .channel("sync")
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "sync_actions" },
          poke
        )
        // Realtime does not replay what happened while it was disconnected.
        .subscribe((status) => status === "SUBSCRIBED" && poke())
      return () => void sb.removeChannel(channel)
    },
  }
}

/**
 * The newest sync id the user can see, for the server's answer to a batch
 * of transactions (see `EngineConfig.send`).
 */
export async function lastSyncId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: SupabaseClient<any, any, any>
) {
  const { data } = await sb
    .from("sync_actions")
    .select("id")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { id: number } | null)?.id ?? 0
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
  sb: SupabaseClient<any, any, any>,
  { name, args }: { name: string; args: unknown[] },
  options: {
    /** Per model the columns a draft may write, e.g. the `COLUMNS` of `supabaseSource`. */
    columns: Record<string, readonly string[]>
    /** Set as `user_id` of created rows. */
    userId: string
    /** Models whose delete sets `deleted_at` instead of deleting the row. */
    softDelete?: readonly string[]
  }
): Promise<{ error?: string } | null> {
  const kinds: string[] = Object.values(DRAFT_MUTATIONS)
  if (!kinds.includes(name)) return null
  const [model, id, fields] = args as [string, string, Record<string, unknown>?]
  const allowed = options.columns[model]
  if (!allowed) return { error: `Unknown model "${model}".` }
  if (typeof id !== "string") return { error: "Missing id." }

  let values: Record<string, unknown> = {}
  if (name !== DRAFT_MUTATIONS.delete) {
    for (const [k, v] of Object.entries(fields ?? {})) {
      if (k === "id" || k === "user_id" || !allowed.includes(k))
        return { error: `The column "${k}" of ${model} cannot be written.` }
      values[k] = v
    }
  }

  let result
  if (name === DRAFT_MUTATIONS.create) {
    values = { ...values, id, user_id: options.userId }
    result = await sb
      .from(model)
      .upsert(values, { onConflict: "id", ignoreDuplicates: true })
  } else if (name === DRAFT_MUTATIONS.update) {
    result = await sb.from(model).update(values).eq("id", id).select("id")
    if (!result.error && !result.data?.length)
      return { error: `The ${model} row ${id} does not exist.` }
  } else if (options.softDelete?.includes(model)) {
    result = await sb
      .from(model)
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id)
  } else {
    result = await sb.from(model).delete().eq("id", id)
  }
  return result.error ? { error: result.error.message } : {}
}
