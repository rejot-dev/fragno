// Vendored from rocicorp/mono@945ce619249e63381fb51d46c12f0d9e80024860 packages/shared/src/string-compare.ts. Do not edit; run scripts/vendor-zql.mjs.
// @ts-nocheck
export function stringCompare(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a < b) {
    return -1;
  }
  return 1;
}
