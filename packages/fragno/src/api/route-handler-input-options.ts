import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { InferOr } from "../util/types-util";
import type { ExtractPathParams } from "./internal/path";

/**
 * Options for calling a route handler
 */
export type RouteHandlerInputOptions<
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
> = {
  pathParams?: ExtractPathParams<TPath>;
  query?: URLSearchParams | Record<string, string>;
  headers?: Headers | Record<string, string>;
} & (TInputSchema extends undefined ? { body?: never } : { body: InferOr<TInputSchema, unknown> });
