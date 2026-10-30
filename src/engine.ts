import { deleteOthers, getAll, openDb, write } from "./idb"
import { Pool, type Change, type Row, type SyncAction } from "./pool"

/**
 * A sync engine after Linear's (see README.md):
 *
 * - All of a user's rows live in the object pool and in IndexedDB. A start
 *   renders from IndexedDB at once and catches up from the last sync id it
 *   has; only the very first start (or a new schema) waits for a bootstrap.
 * - The server numbers every change (`sync_actions`). Realtime pokes the
 *   engine, which fetches everything after its last sync id, in order.
 * - Edits are transactions: their changes show in the pool in the same
 *   tick, they are stored in IndexedDB and sent in batches, in order. A
 *   failed one is rolled back; a confirmed one stays laid over the pool
 *   until the sync action carrying its effect has arrived, so nothing
 *   flickers back. Transactions survive a reload or a lost connection and
 *   are sent later; a tab sends its own, and those of tabs that were closed.
 *
 * This file knows nothing of the app: the models and how to talk to the
 * server come in through `EngineConfig`.
 */

/** What the engine needs from the app. */
export type EngineConfig = {
  /** IndexedDB name; one database per user. */
  name: string
  /** Bump to drop the local cache (new models or columns). */
  schemaVersion: number
  models: readonly string[]
  /** Every row the user may read, and the sync id they are as of. */
  bootstrap(): Promise<{ lastSyncId: number; rows: Record<string, Row[]> }>
  /** Sync actions after `syncId`, oldest first, at most `limit`. */
  delta(syncId: number, limit: number): Promise<SyncAction[]>
  /** Calls `poke` when there may be new sync actions; returns the unsubscribe. */
  subscribe(poke: () => void): () => void
  /**
   * Sends transactions to the server, which runs them in order. Throws when
   * the server could not be reached (they are sent again later).
   */
  send(
    batch: { name: string; args: unknown[] }[]
  ): Promise<{ error?: string; syncId: number }[]>
  /** A transaction failed that no caller waits for (e.g. sent after a reload). */
  onError(name: string, error: string): void
}

/** An edit: the server mutation (`name`, `args`) and its optimistic changes. */
type Transaction = {
  id: string
  /** The tab that sends it. */
  tab: string
  name: string
  args: unknown[]
  changes: Change[]
  /** Set once the server ran it; done once the pool has this sync id. */
  syncId?: number
}

const META = "_meta"
const TRANSACTIONS = "_transactions"
const DELTA_LIMIT = 1000
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000]

export class SyncEngine {
  readonly pool: Pool
  /** Resolves once the pool holds data (from IndexedDB or a bootstrap). */
  readonly ready: Promise<void>
  isReady = false

  private db: IDBDatabase | null = null
  private lastSyncId = 0
  private tab = crypto.randomUUID()
  private transactions: Transaction[] = []
  private waiting = new Map<string, (error: string | undefined) => void>()
  private sending = false
  private retries = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private catchingUp: Promise<void> | null = null
  private catchUpAgain = false
  private cleanup: (() => void)[] = []

  constructor(private config: EngineConfig) {
    this.pool = new Pool(config.models)
    let markReady!: () => void
    this.ready = new Promise((resolve) => (markReady = resolve))
    void this.start().then(() => {
      this.isReady = true
      this.pool.touch()
      markReady()
    })
  }

  /**
   * Makes an edit: applies `changes` to the pool now and sends the server
   * mutation `name(...args)` behind it. Resolves to the error message once
   * it failed (and was rolled back), or undefined once the server ran it.
   */
  commit(name: string, args: unknown[], changes: Change[]) {
    const tx: Transaction = {
      id: crypto.randomUUID(),
      tab: this.tab,
      name,
      args,
      changes,
    }
    this.transactions.push(tx)
    this.pool.push(tx.id, changes)
    void this.store([tx])
    const result = new Promise<string | undefined>((resolve) =>
      this.waiting.set(tx.id, resolve)
    )
    queueMicrotask(() => void this.flush())
    return result
  }

  /** Fetches what changed on the server now (e.g. after a server action). */
  sync() {
    return this.catchUp()
  }

  /** Whether edits are waiting to be sent or confirmed. */
  get pending() {
    return this.transactions.length > 0
  }

  /** The IndexedDB name. */
  get name() {
    return this.config.name
  }

  stop() {
    clearTimeout(this.retryTimer)
    for (const c of this.cleanup) c()
    this.db?.close()
  }

  private async start() {
    const { name, schemaVersion, models } = this.config
    // Another user's cache has no business on this device.
    void deleteOthers(name.slice(0, name.lastIndexOf(":") + 1), name).catch(
      () => {}
    )
    this.holdTabLock()

    try {
      this.db = await openDb(name, schemaVersion, [
        ...models,
        META,
        TRANSACTIONS,
      ])
    } catch {
      // Private mode or blocked storage: run from memory only.
      this.db = null
    }

    const cached = await this.readCache().catch(() => null)
    if (cached) {
      this.pool.load(cached.rows)
      this.lastSyncId = cached.lastSyncId
      await this.adopt(cached.transactions)
      this.subscribe()
      void this.catchUp()
    } else {
      await this.bootstrap()
      this.subscribe()
    }
    void this.flush()
  }

  private async readCache() {
    const db = this.db
    if (!db) return null
    const [meta] = await getAll<{ id: string; lastSyncId: number }>(db, META)
    // Written with the bootstrap: without it the stores are not complete.
    if (!meta) return null
    const rows: Record<string, Row[]> = {}
    await Promise.all(
      this.config.models.map(async (m) => (rows[m] = await getAll(db, m)))
    )
    const transactions = await getAll<Transaction>(db, TRANSACTIONS)
    return { lastSyncId: meta.lastSyncId, rows, transactions }
  }

  /**
   * Takes over stored transactions whose tab is gone (reloaded or closed).
   * Those of tabs still open stay theirs.
   */
  private async adopt(stored: Transaction[]) {
    const held = new Set(
      ((await navigator.locks?.query())?.held ?? []).map((l) => l.name)
    )
    const mine = stored.filter((tx) => !held.has(lockName(tx.tab)))
    for (const tx of mine) {
      tx.tab = this.tab
      this.transactions.push(tx)
      this.pool.push(tx.id, tx.changes)
    }
    await this.store(mine)
  }

  /** Held as long as this tab lives, so other tabs know it is open. */
  private holdTabLock() {
    void navigator.locks?.request(
      lockName(this.tab),
      () => new Promise<void>(() => {})
    )
  }

  private async bootstrap() {
    // Retried until it works: without it there is nothing to show.
    for (let attempt = 0; ; attempt++) {
      try {
        const { lastSyncId, rows } = await this.config.bootstrap()
        this.pool.load(rows)
        this.lastSyncId = lastSyncId
        await this.persistAll(rows)
        return
      } catch (e) {
        console.error("sync bootstrap failed", e)
        await sleep(RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)])
      }
    }
  }

  private subscribe() {
    let timer: ReturnType<typeof setTimeout> | undefined
    const poke = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void this.catchUp(), 50)
    }
    const online = () => {
      poke()
      void this.flush()
    }
    const visible = () => document.visibilityState === "visible" && online()
    window.addEventListener("online", online)
    document.addEventListener("visibilitychange", visible)
    const unsubscribe = this.config.subscribe(poke)
    this.cleanup.push(() => {
      clearTimeout(timer)
      unsubscribe()
      window.removeEventListener("online", online)
      document.removeEventListener("visibilitychange", visible)
    })
  }

  /** Applies every sync action after `lastSyncId`; one run at a time. */
  private catchUp(): Promise<void> {
    if (this.catchingUp) {
      this.catchUpAgain = true
      return this.catchingUp
    }
    this.catchingUp = (async () => {
      try {
        do {
          this.catchUpAgain = false
          for (;;) {
            const actions = await this.config.delta(
              this.lastSyncId,
              DELTA_LIMIT
            )
            if (actions.length) await this.applyActions(actions)
            if (actions.length < DELTA_LIMIT) break
          }
        } while (this.catchUpAgain)
      } catch (e) {
        // The next poke (realtime, focus, online) tries again.
        console.error("sync catch-up failed", e)
      } finally {
        this.catchingUp = null
      }
    })()
    return this.catchingUp
  }

  private async applyActions(actions: SyncAction[]) {
    const touched = this.pool.apply(actions)
    this.lastSyncId = actions.at(-1)!.id
    this.completeConfirmed()
    const db = this.db
    if (!db) return
    await write(db, [...touched.keys(), META], (store) => {
      for (const [model, ids] of touched)
        for (const id of ids) {
          const row = this.pool.baseRow(model, id)
          if (row) store(model).put(row)
          else store(model).delete(id)
        }
      store(META).put({ id: "meta", lastSyncId: this.lastSyncId })
    }).catch((e) => console.error("sync cache write failed", e))
  }

  /** Drops the transactions whose effect has arrived as a sync action. */
  private completeConfirmed() {
    const done = this.transactions.filter(
      (tx) => tx.syncId !== undefined && tx.syncId <= this.lastSyncId
    )
    if (!done.length) return
    this.transactions = this.transactions.filter((tx) => !done.includes(tx))
    for (const tx of done) this.pool.drop(tx.id)
    void this.unstore(done)
  }

  /** Sends the transactions not sent yet, in order, as batches. */
  private async flush() {
    if (this.sending) return
    const batch = this.transactions.filter(
      (tx) => tx.syncId === undefined && tx.tab === this.tab
    )
    if (!batch.length) return

    this.sending = true
    let results
    try {
      results = await this.config.send(
        batch.map(({ name, args }) => ({ name, args }))
      )
      this.retries = 0
    } catch {
      // Offline or the server is down: the batch stays and goes again later.
      this.sending = false
      const delay = RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)]
      clearTimeout(this.retryTimer)
      this.retryTimer = setTimeout(() => void this.flush(), delay)
      return
    }
    this.sending = false

    const failed: Transaction[] = []
    batch.forEach((tx, i) => {
      const { error, syncId } = results[i] ?? { error: "Keine Antwort." }
      const resolve = this.waiting.get(tx.id)
      this.waiting.delete(tx.id)
      if (error) {
        failed.push(tx)
        this.pool.drop(tx.id)
        if (resolve) resolve(error)
        else this.config.onError(tx.name, error)
      } else {
        tx.syncId = syncId
        resolve?.(undefined)
      }
    })
    this.transactions = this.transactions.filter((tx) => !failed.includes(tx))
    void this.unstore(failed)
    void this.store(batch.filter((tx) => !failed.includes(tx)))
    this.completeConfirmed()
    if (this.transactions.some((tx) => tx.syncId !== undefined))
      void this.catchUp()
    // Edits made while this batch was on its way.
    void this.flush()
  }

  private async persistAll(rows: Record<string, Row[]>) {
    const db = this.db
    if (!db) return
    const models = this.config.models
    await write(db, [...models, META], (store) => {
      for (const m of models) {
        store(m).clear()
        for (const r of rows[m] ?? []) store(m).put(r)
      }
      store(META).put({ id: "meta", lastSyncId: this.lastSyncId })
    }).catch((e) => console.error("sync cache write failed", e))
  }

  private async store(txs: Transaction[]) {
    if (!this.db || !txs.length) return
    await write(this.db, [TRANSACTIONS], (store) => {
      for (const tx of txs) store(TRANSACTIONS).put(tx)
    }).catch(() => {})
  }

  private async unstore(txs: Transaction[]) {
    if (!this.db || !txs.length) return
    await write(this.db, [TRANSACTIONS], (store) => {
      for (const tx of txs) store(TRANSACTIONS).delete(tx.id)
    }).catch(() => {})
  }
}

const lockName = (tab: string) => `sync-tab:${tab}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
