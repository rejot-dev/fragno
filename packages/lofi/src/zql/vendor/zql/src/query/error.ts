// Vendored from rocicorp/mono@945ce619249e63381fb51d46c12f0d9e80024860 packages/zql/src/query/error.ts. Do not edit; run scripts/vendor-zql.mjs.
// @ts-nocheck
export class QueryParseError extends Error {
  constructor(opts: ErrorOptions) {
    super(
      opts?.cause instanceof Error
        ? `Failed to parse arguments for query: ${opts.cause.message}`
        : `Failed to parse arguments for query`,
      opts,
    );
    this.name = 'QueryParseError';
  }
}
