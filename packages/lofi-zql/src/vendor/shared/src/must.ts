// Vendored from rocicorp/mono@945ce619249e63381fb51d46c12f0d9e80024860 packages/shared/src/must.ts. Do not edit; run scripts/vendor-zql.mjs.
// @ts-nocheck
export function must<T>(v: T | undefined | null, msg?: string): T {
  // oxlint-disable-next-line eqeqeq
  if (v == null) {
    throw new Error(msg ?? `Unexpected ${v} value`);
  }
  return v;
}
