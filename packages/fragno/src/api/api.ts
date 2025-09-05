import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { RequestInputContext } from "./request-input-context";
import type { RequestOutputContext } from "./request-output-context";

export type HTTPMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";
export type NonGetHTTPMethod = Exclude<HTTPMethod, "GET">;

// Helper type to create branded error messages that are still assignable to string
type PathError<T extends string, TMessage extends string> = T & [`Error: ${TMessage}`];

/**
 * A valid path string that:
 * - Is non-empty
 * - Starts with "/"
 * - Is not just "/"
 * - Does not end with "/"
 */
export type ValidPath<T extends string = string> = T extends `/${infer Rest}`
  ? Rest extends ""
    ? PathError<T, "Path cannot be just '/'."> // Excludes "/"
    : T extends `${string}/`
      ? PathError<T, "Path cannot end with '/'."> // Excludes paths ending with "/"
      : T
  : PathError<T, "Path must start with '/'.">; // Excludes paths not starting with "/"

export interface FragnoRouteConfig<
  TMethod extends HTTPMethod,
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined,
  TErrorCode extends string = string,
  TQueryParameters extends string = string,
> {
  method: TMethod;
  path: TPath;
  inputSchema?: TInputSchema;
  outputSchema?: TOutputSchema;
  errorCodes?: TErrorCode[];
  queryParameters?: TQueryParameters[];
  handler(
    inputCtx: RequestInputContext<TPath, TInputSchema>,
    outputCtx: RequestOutputContext<TOutputSchema, TErrorCode>,
  ): Promise<Response>;
}

// Overload for routes without inputSchema
export function addRoute<
  TMethod extends HTTPMethod,
  TPath extends string,
  TOutputSchema extends StandardSchemaV1 | undefined,
  TErrorCode extends string = string,
  TQueryParameters extends string = string,
>(
  route: FragnoRouteConfig<
    TMethod,
    ValidPath<TPath>,
    undefined,
    TOutputSchema,
    TErrorCode,
    TQueryParameters
  > & { inputSchema?: undefined },
): FragnoRouteConfig<TMethod, TPath, undefined, TOutputSchema, TErrorCode, TQueryParameters>;

// Overload for routes with inputSchema
export function addRoute<
  TMethod extends HTTPMethod,
  TPath extends string,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1 | undefined,
  TErrorCode extends string = string,
  TQueryParameters extends string = string,
>(
  route: FragnoRouteConfig<
    TMethod,
    ValidPath<TPath>,
    TInputSchema,
    TOutputSchema,
    TErrorCode,
    TQueryParameters
  > & {
    inputSchema: TInputSchema;
  },
): FragnoRouteConfig<TMethod, TPath, TInputSchema, TOutputSchema, TErrorCode, TQueryParameters>;

// Implementation
export function addRoute<
  TMethod extends HTTPMethod,
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined,
  TErrorCode extends string = string,
  TQueryParameters extends string = string,
>(
  route: FragnoRouteConfig<
    TMethod,
    ValidPath<TPath>,
    TInputSchema,
    TOutputSchema,
    TErrorCode,
    TQueryParameters
  >,
): FragnoRouteConfig<TMethod, TPath, TInputSchema, TOutputSchema, TErrorCode, TQueryParameters> {
  return route;
}

export { FragnoApiError, FragnoApiValidationError } from "./error";
