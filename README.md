# Sync engine

A local-first sync engine after Linear's, for React + Supabase. Peer dependencies: `react` 19 and `@supabase/supabase-js` 2.

## How it works

- **Object pool.** Every row the user may read lives in memory (`src/pool.ts`) and in IndexedDB (`src/idb.ts`, one database per user). After the first visit, the app renders from IndexedDB at once and catches up in the background.
- **Sync actions.** A trigger appends each change of a synced table to `sync_actions`. The `id` of that row is the sync id, and a user's sync ids commit in order. The client keeps its `lastSyncId` and fetches everything after it. Realtime on `sync_actions` only pokes the client to fetch; it is not the source of truth. Focus and `online` poke it too.
- **Bootstrap.** Runs on the first start, or when `schemaVersion` changes: it loads all rows plus the sync id they are as of. Lazy models are left out; queries load their rows from a server view (see step 7).
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
4. Register your models (and, if you like, your mutations) once, so every API is typed by them:

   ```ts
   // sync.ts
   import type { Columns } from "@jannesrudnick/sync-engine"

   export type Issue = { id: string; title: string; status: "todo" | "done"; pinned: boolean; project_id: string }
   export type Project = { id: string; name: string }

   declare module "@jannesrudnick/sync-engine" {
     interface Register {
       schema: { issues: Issue; projects: Project }
       mutations: { setTitle: [id: string, title: string] } // optional
     }
   }

   export const COLUMNS = {
     issues: ["id", "title", "status", "pinned", "project_id"],
     projects: ["id", "name"],
   } satisfies Columns // a misspelt column is a type error
   ```

   Without it, models are any string and rows are `Row`.

5. In the browser, once per page load:

   ```ts
   import { SyncEngine, supabaseSource } from "@jannesrudnick/sync-engine"
   import { setEngine } from "@jannesrudnick/sync-engine/react"

   setEngine(
     new SyncEngine({
       name: `myapp-sync:${userId}`,
       schemaVersion: 1,
       ...supabaseSource(createBrowserClient(), COLUMNS), // models, bootstrap, delta, realtime, queries
       lazy: ["issues"], // optional: loaded by queries only (step 7)
       send: runTransactions,
       onError: (_name, error) => toast.error(error),
     })
   )
   ```

6. Read with views, and write with `commit`:

   ```ts
   import { getEngine, useView, view } from "@jannesrudnick/sync-engine/react"

   const issueView = view(["issues"], (pool, id) => pool.get("issues", id))
   const issue = useView(issueView, id) // Issue | undefined, undefined until loaded

   getEngine().commit(
     "setTitle",
     [id, title],
     [{ model: "issues", id, op: "patch", patch: { title } }]
   )
   ```

   `useLoadedView` + `<SyncGate fallback={…}>` suspend instead of returning undefined.

7. Load what a screen needs with queries, when a model is too large to bootstrap. A query fetches the rows a server view returns; they go into the pool like any other rows, so edits, drafts and sync actions work on them:

   ```sql
   -- security_invoker: the view runs with the user's RLS, not its owner's.
   create view open_issues with (security_invoker = true) as
     select * from issues where status <> 'done';
   ```

   ```tsx
   import { useDraft, useQuery } from "@jannesrudnick/sync-engine/react"

   function OpenIssues({ projectId }: { projectId: string }) {
     const issues = useQuery({
       model: "issues",
       source: "open_issues",
       params: { project_id: projectId }, // project_id = $1, typed by Issue
       filter: (i) => i.project_id === projectId && i.status !== "done",
     }) // Issue[] | undefined
     if (!issues) return <Spinner />
     return <ul>{issues.map((i) => <IssueRow key={i.id} id={i.id} />)}</ul>
   }

   function IssueRow({ id }: { id: string }) {
     const issue = useDraft("issues", id) // Draft<Issue>
     if (!issue) return null
     return (
       <li>
         {issue.title}
         <button onClick={() => { issue.pinned = !issue.pinned; issue.save() }}>
           {issue.pinned ? "Pinned" : "Pin"}
         </button>
       </li>
     )
   }
   ```

   - The view returns whole rows of one model, not joins: join in the client (`pool.get`), so a joined copy can't miss an edit. Only the columns in `COLUMNS` are read.
   - With `filter` (the view's condition, in TypeScript) the result is every row in the pool that passes: an edit that ends the match, or a new row that starts one, shows at once. Without it, the result is the rows the last fetch returned, fetched again whenever the model changes while it is shown.
   - Results are cached in IndexedDB, so the next visit shows them at once and fetches in the background.
   - `useLoadedQuery` suspends instead of returning undefined; `getEngine().loadQuery(spec)` / `queryRows(spec)` outside React.
   - Rows of lazy models that change while the app runs arrive by sync action and stay in the pool.

8. Or write with drafts, as with Linear's models: assign fields, then `save()`. A save is a `commit` of a generic mutation (`sync.create` / `sync.update` / `sync.delete`), so it is optimistic, queued and rolled back like any other edit.

   ```ts
   const issue = getEngine().draft("issues", id) // Draft<Issue>
   issue.title = "New title"
   issue.status = "done"
   await issue.save() // patches only the fields that differ from the pool

   const created = getEngine().create("issues", { title: "New" })
   await created.save() // inserts; not in the pool before
   await issue.delete()
   ```

   Unset fields read through to the pool, so a draft shows what changes elsewhere. `isDirty`, `isNew` and `discard()` are there too; `save`, `delete`, `discard`, `isDirty` and `isNew` can't be column names. In React, `useDraft("issues", id)` keeps one draft per row and re-renders when you assign to it.

   On the server, run them with `runDraftMutation` in the batch of step 3. It writes only the columns you list (never `id` or `user_id`) and returns null for your own mutations:

   ```ts
   for (const m of batch) {
     const r = await runDraftMutation(sb, m, { columns: COLUMNS, userId, softDelete: ["issues"] })
     results.push(r ?? (await runOwnMutation(m)))
   }
   ```

   Keep named mutations (`commit`) for edits with rules or side effects; drafts are for plain field updates.

## Developing

`npm install`, then `npm run typecheck` / `npm run build`. `dist` is committed, so installs need no build step: rebuild and commit it with every change. Bump `version` in `package.json` and tag (`v0.2.0`) to release; apps pin a tag with `github:jannesrudnick/sync-engine#v0.2.0`.

## Limits

- One sync group per user (`user_id`). Linear has workspaces and teams. A team model would add a group column and filter on it.
- Views scan whole models. Add indexes by foreign key once a model holds tens of thousands of rows.
- Lazy models (step 7) are loaded by equality queries on a view; ranges, paging and search need a view per case. Their rows are never evicted from the pool. Leave large columns out of the trigger and load them on demand.
- `sync_actions` is never pruned. Prune old rows once it gets large: a client behind the oldest row then needs a full bootstrap (TODO: detect it).
