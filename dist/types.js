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
export {};
