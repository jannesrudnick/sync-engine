/**
 * Types shared by the whole package. The app registers its models (and,
 * optionally, its mutations) once, and every API is typed by them:
 *
 *   declare module "@jannesrudnick/sync-engine" {
 *     interface Register {
 *       schema: { issues: Issue; projects: Project }
 *       mutations: { setTitle: [id: string, title: string] }
 *     }
 *   }
 *
 * Without it, models are any string and rows are `Row`.
 */
/** Any row: every synced table has a uuid `id`. */
export type Row = {
    id: string;
} & Record<string, unknown>;
export interface Register {
}
/** The registered models: model name → row type. */
export type Schema = Register extends {
    schema: infer S extends Record<string, {
        id: string;
    }>;
} ? S : Record<string, Row>;
export type ModelName = keyof Schema & string;
/** The row type of `model`. */
export type RowOf<M extends ModelName> = Schema[M];
/** The columns of `model` other than `id`. */
export type FieldsOf<M extends ModelName> = Omit<RowOf<M>, "id">;
/** One optimistic change of one model. */
export type ChangeOf<M extends ModelName> = {
    model: M;
    id: string;
    op: "set";
    row: RowOf<M>;
} | {
    model: M;
    id: string;
    op: "patch";
    patch: Partial<FieldsOf<M>>;
} | {
    model: M;
    id: string;
    op: "delete";
};
/** One optimistic change of a transaction, of any model. */
export type Change = {
    [M in ModelName]: ChangeOf<M>;
}[ModelName];
type Mutations = Register extends {
    mutations: infer X extends Record<string, unknown[]>;
} ? X : Record<string, unknown[]>;
/** The registered server mutations (`commit`'s `name`). */
export type MutationName = keyof Mutations & string;
/** The arguments of mutation `N`. */
export type MutationArgs<N extends MutationName> = Mutations[N];
/** Per model the columns its trigger records (`supabaseSource`). */
export type Columns = {
    [M in ModelName]: readonly (keyof RowOf<M> & string)[];
};
type Primitive = string | number | boolean | null;
/**
 * A query: the rows of `model` that the server view (or table) `source`
 * returns for `params`. See `SyncEngine.queryRows`.
 */
export type QuerySpec<M extends ModelName> = {
    model: M;
    /** A Postgres view (with `security_invoker`) or table returning rows of `model`. */
    source: string;
    /** Equality filters on the source: `column = value`. */
    params?: {
        [K in keyof RowOf<M> & string]?: Extract<RowOf<M>[K], Primitive>;
    };
    /**
     * The same condition as the source, on the client. With it, the result
     * is every row in the pool that passes, so edits and new rows show at
     * once; without it, the rows the last fetch returned. It may only depend
     * on `params`: the result is cached by them.
     */
    filter?: (row: RowOf<M>) => boolean;
    sort?: (a: RowOf<M>, b: RowOf<M>) => number;
};
export {};
