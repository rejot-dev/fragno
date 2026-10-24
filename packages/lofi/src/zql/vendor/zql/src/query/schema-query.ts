// Vendored from rocicorp/mono@945ce619249e63381fb51d46c12f0d9e80024860 packages/zql/src/query/schema-query.ts. Do not edit; run scripts/vendor-zql.mjs.
// @ts-nocheck
import type {Schema} from '../../../zero-types/src/schema.ts';
import type {Query} from './query.ts';

// Note: Using Query<K, S> without explicit third type parameter is
// intentional. When the default PullRow<K, S> is left implicit, TypeScript
// defers its evaluation, which prevents "type exceeds maximum length" errors
// in deeply chained .related() calls (e.g., 90+ calls in stress tests).
export type SchemaQuery<S extends Schema> = {
  readonly [K in keyof S['tables'] & string]: Query<K, S>;
};

export type ConditionalSchemaQuery<S extends Schema> =
  S['enableLegacyQueries'] extends true ? SchemaQuery<S> : undefined;
