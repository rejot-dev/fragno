// Vendored from rocicorp/mono@945ce619249e63381fb51d46c12f0d9e80024860 packages/shared/src/config.ts. Do not edit; run scripts/vendor-zql.mjs.
// @ts-nocheck
declare const process: {
  env: {
    NODE_ENV?: string;
  };
};

export const isProd = (globalThis as {process?: {env?: Record<string, string | undefined>}}).process?.env?.NODE_ENV === 'production';

export {isProd as skipAssertJSONValue};
