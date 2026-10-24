// Vendored from rocicorp/mono@945ce619249e63381fb51d46c12f0d9e80024860 packages/shared/src/testing.ts. Do not edit; run scripts/vendor-zql.mjs.
// @ts-nocheck
import {assert} from './asserts.ts';

export const TESTING = import.meta.env?.VITEST;

export function assertTesting(msg = 'Expected to be in test mode'): void {
  assert(TESTING, msg);
}
