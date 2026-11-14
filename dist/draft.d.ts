import type { SyncEngine } from "./engine";
import type { Row } from "./types";
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
export declare const DRAFT_MUTATIONS: {
    readonly create: "sync.create";
    readonly update: "sync.update";
    readonly delete: "sync.delete";
};
export type DraftMethods = {
    /**
     * Commits the changed fields (all of them for a new draft). Resolves like
     * `commit`: to the error message once it failed and was rolled back, or
     * undefined once the server ran it. Without changes it does nothing.
     */
    save(): Promise<string | undefined>;
    /** Deletes the row (a new draft is only discarded). */
    delete(): Promise<string | undefined>;
    /** Forgets the fields set since the last save. */
    discard(): void;
    /** Whether fields were set that differ from the pool. */
    readonly isDirty: boolean;
    /** Whether the row is not saved yet (from `create`). */
    readonly isNew: boolean;
};
/** A row you assign fields on; `save()` commits them. */
export type Draft<T extends {
    id: string;
} = Row> = Omit<T, "id"> & {
    readonly id: string;
} & DraftMethods;
type Engine = Pick<SyncEngine, "pool" | "commit">;
export declare function makeDraft<T extends {
    id: string;
}>(engine: Engine, model: string, id: string, isNew: boolean, fields?: Record<string, unknown>): Draft<T>;
/** For `useDraft`: calls `listener` when fields are set or saved. */
export declare function onDraftChange(draft: object, listener: () => void): () => void;
/** For `useDraft`: grows with every change of the draft. */
export declare function draftVersion(draft: object): number;
export {};
