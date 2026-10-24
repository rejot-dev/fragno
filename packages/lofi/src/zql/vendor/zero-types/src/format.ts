// Vendored from rocicorp/mono@945ce619249e63381fb51d46c12f0d9e80024860 packages/zero-types/src/format.ts. Do not edit; run scripts/vendor-zql.mjs.
// @ts-nocheck
/**
 * Format descriptor for query results.
 * Describes whether a result should be singular or a list,
 * and what the format of nested relationships should be.
 */
export type Format = {
  singular: boolean;
  relationships: Record<string, Format>;
};

export const defaultFormat: Format = {
  singular: false,
  relationships: {},
} as const;
