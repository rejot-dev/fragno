import type { z } from "zod";

/** A permission named by its namespace, e.g. `{ namespace: "events", permission: "emit" }`. */
export type BackofficeApiPermission = { readonly namespace: string; readonly permission: string };

/**
 * One callable operation. Its id is its key in the API's operation map. The caller names the scope
 * it runs in in the request path; Backoffice decides per request whether the operation is
 * available there for the credential, and requires every listed permission in that scope. Input
 * and output are validated by the server; a `z.void()` input means the request has no body, and a
 * `z.void()` output means the response has none.
 */
export type BackofficeApiOperation<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> = {
  description: string;
  permissions: readonly BackofficeApiPermission[];
  input: TInput;
  output: TOutput;
};

/** One version of the API, served under `/api/<version>`. */
export type BackofficeApi<
  TOperations extends Record<string, BackofficeApiOperation> = Record<
    string,
    BackofficeApiOperation
  >,
> = {
  version: `v${number}`;
  operations: TOperations;
};

/**
 * A server's handler for every operation of an API version. Handlers receive input already
 * validated by the operation and return a value its output schema accepts.
 */
export type BackofficeApiImplementation<TApi extends BackofficeApi, TContext> = {
  [TId in keyof TApi["operations"]]: (
    input: z.output<TApi["operations"][TId]["input"]>,
    context: TContext,
  ) => Promise<z.input<TApi["operations"][TId]["output"]>>;
};
