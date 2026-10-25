// Vendored from rocicorp/mono@945ce619249e63381fb51d46c12f0d9e80024860 packages/shared/src/writable.ts. Do not edit; run scripts/vendor-zql.mjs.
// @ts-nocheck
export type Writable<T> = {
  -readonly [P in keyof T]: T[P];
};
