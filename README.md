# Sync engine

A local-first sync engine after Linear's, for React + Supabase. Peer dependencies: `react` 19 and `@supabase/supabase-js` 2.

## How it works

- **Object pool.** Every row the user may read lives in memory (`src/pool.ts`) and in IndexedDB (`src/idb.ts`, one database per user). After the first visit, the app renders from IndexedDB at once and catches up in the background.
- **Sync actions.** A trigger appends each change of a synced table to `sync_actions`. The `id` of that row is the sync id, and a user's sync ids commit in order. The client keeps its `lastSyncId` and fetches everything after it. Realtime on `sync_actions` only pokes the client to fetch; it is not the source of truth. Focus and `online` poke it too.
- **Bootstrap.** Runs on the first start, or when `schemaVersion` changes: it loads all rows plus the sync id they are as of.
- **Transactions.** An edit is a server mutation (`name`, `args`) plus its optimistic changes (`set` / `patch` / `delete` of rows):
  - The changes are laid over the pool in the same tick.
  - The transaction is stored in IndexedDB and sent in batches, in order (`EngineConfig.send`).
  - A failed transaction is rolled back. A confirmed one stays laid over the pool until the sync action carrying its effect has arrived, so nothing flickers.
  - Sync actions arriving in between rebase the pending changes: the server state goes underneath, and the pending changes are applied on top again.
- **Offline and tabs.** Transactions survive reloads and lost connections and are retried with backoff. Each tab sends its own transactions. A tab also takes over the stored transactions of tabs that are gone; it tells which tabs are gone through Web Locks.

## Using it

1. Install it from git (built on install by `prepare`):

   ```sh
   pnpm add github:jannesrudnick/sync-engine
   ```

   It ships ES modules for a bundler (Next.js, Vite); Node alone can't import it.

2. Copy `schema.sql` (also at `node_modules/@jannesrudnick/sync-engine/schema.sql`) into a migration. Add one `create trigger … record_sync_action('id', 'user_id', …columns)` per synced table, and add `sync_actions` to the realtime publication. Synced tables need `id uuid` and `user_id uuid`; RLS on `sync_actions` scopes rows to `user_id`.
3. Write a server action that runs a batch of mutations in order (at most `BATCH_LIMIT`, 100, per call), with each mutation safe to run twice. It returns `{ error?, syncId }` per entry, with `syncId = await lastSyncId(serverClient)` taken after the batch.
4. In the browser, once per page load:

   ```ts
   import { SyncEngine, supabaseSource } from "@jannesrudnick/sync-engine"
   import { setEngine } from "@jannesrudnick/sync-engine/react"

   setEngine(
     new SyncEngine({
       name: `myapp-sync:${userId}`,
       schemaVersion: 1,
       models: Object.keys(COLUMNS),
       ...supabaseSource(createBrowserClient(), COLUMNS),
       send: runTransactions,
       onError: (_name, error) => toast.error(error),
     })
   )
   ```

5. Read with views, and write with `commit`:

   ```ts
   import { getEngine, useView, view } from "@jannesrudnick/sync-engine/react"

   const issueView = view(["issues"], (pool, id) => pool.get("issues", id))
   const issue = useView(issueView, id) // undefined until loaded

   getEngine().commit(
     "setTitle",
     [id, title],
     [{ model: "issues", id, op: "patch", patch: { title } }]
   )
   ```

   `useLoadedView` + `<SyncGate fallback={…}>` suspend instead of returning undefined.

## Developing

`npm install`, then `npm run typecheck` / `npm run build`. `dist` is committed, so installs need no build step: rebuild and commit it with every change. Bump `version` in `package.json` and tag (`v0.2.0`) to release; apps pin a tag with `github:jannesrudnick/sync-engine#v0.2.0`.

## Limits

- One sync group per user (`user_id`). Linear has workspaces and teams. A team model would add a group column and filter on it.
- Views scan whole models. Add indexes by foreign key once a model holds tens of thousands of rows.
- No lazy models: everything synced is bootstrapped. Leave large columns out of the trigger and load them on demand.
- `sync_actions` is never pruned. Prune old rows once it gets large: a client behind the oldest row then needs a full bootstrap (TODO: detect it).
