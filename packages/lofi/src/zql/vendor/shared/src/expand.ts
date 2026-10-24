// Vendored from rocicorp/mono@945ce619249e63381fb51d46c12f0d9e80024860 packages/shared/src/expand.ts. Do not edit; run scripts/vendor-zql.mjs.
// @ts-nocheck
/**
 * Expand/simplifies a type for display in Intellisense.
 */
export type Expand<T> = T extends infer O ? {[K in keyof O]: O[K]} : never;

export type ExpandRecursive<T> = T extends object
  ? T extends infer O
    ? {[K in keyof O]: ExpandRecursive<O[K]>}
    : never
  : T;
