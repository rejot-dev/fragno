// Vendored from rocicorp/mono@945ce619249e63381fb51d46c12f0d9e80024860 packages/zql/src/query/typed-view.ts. Do not edit; run scripts/vendor-zql.mjs.
// @ts-nocheck
import type {Immutable} from '../../../shared/src/immutable.ts';
import type {ErroredQuery} from '../../../zero-protocol/src/custom-queries.ts';
import type {TTL} from './ttl.ts';

export type ResultType = 'unknown' | 'cached' | 'complete' | 'error';

/**
 * Called when the view changes. The received data should be considered
 * immutable. Caller must not modify it. Passed data is valid until next
 * time listener is called.
 */
export type Listener<T> = (
  data: Immutable<T>,
  resultType: ResultType,
  error?: ErroredQuery,
) => void;

export type TypedView<T> = {
  addListener(listener: Listener<T>): () => void;
  destroy(): void;
  updateTTL(ttl: TTL): void;
  readonly data: T;
};
