// Vendored from rocicorp/mono@945ce619249e63381fb51d46c12f0d9e80024860 packages/zero-protocol/src/error-reason-enum.ts. Do not edit; run scripts/vendor-zql.mjs.
// @ts-nocheck
export const Database = 'database';
export const Parse = 'parse';
export const OutOfOrderMutation = 'oooMutation';
export const UnsupportedPushVersion = 'unsupportedPushVersion';
export const Internal = 'internal';
export const HTTP = 'http';
export const Timeout = 'timeout';

export type Database = typeof Database;
export type Parse = typeof Parse;
export type OutOfOrderMutation = typeof OutOfOrderMutation;
export type UnsupportedPushVersion = typeof UnsupportedPushVersion;
export type Internal = typeof Internal;
export type HTTP = typeof HTTP;
export type Timeout = typeof Timeout;
