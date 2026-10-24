// Vendored from rocicorp/mono@945ce619249e63381fb51d46c12f0d9e80024860 packages/shared/src/sentinels.ts. Do not edit; run scripts/vendor-zql.mjs.
// @ts-nocheck
export function emptyFunction() {}
export const emptyObject = Object.freeze({});
export const emptyArray = Object.freeze([]);
export function identity<T>(x: T): T {
  return x;
}
