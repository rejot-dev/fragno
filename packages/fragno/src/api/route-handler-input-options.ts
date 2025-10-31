import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ExtractPathParams } from "./internal/path";

/**
 * Options for calling a route handler
 */
export interface RouteHandlerInputOptions<
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
> {
  pathParams?: ExtractPathParams<TPath>;
  body?: TInputSchema extends StandardSchemaV1
    ? StandardSchemaV1.InferInput<TInputSchema>
    : unknown;
  query?: URLSearchParams | Record<string, string>;
  headers?: Headers | Record<string, string>;
}
