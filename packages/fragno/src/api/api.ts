import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { RequestInputContext } from "./request-input-context";
import type { RequestOutputContext } from "./request-output-context";

export type { StandardSchemaV1 } from "@standard-schema/spec";

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

export interface RequestThisContext {}

/**
 * Content types that can be accepted by a route.
 *
 * - `"application/json"` (default): JSON request body, validated against inputSchema
 * - `"multipart/form-data"`: FormData request body (file uploads), no schema validation
 */
export type RouteContentType =
  | "application/json"
  | "multipart/form-data"
  | "application/octet-stream";

export interface FragnoRouteConfig<
  TMethod extends HTTPMethod,
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined,
  TErrorCode extends string = string,
  TQueryParameters extends string = string,
  TThisContext extends RequestThisContext = RequestThisContext,
> {
  method: TMethod;
  path: TPath;
  /**
   * The expected content type for this route's request body.
   *
   * - `"application/json"` (default): Expects JSON body, will be validated against inputSchema
   * - `"multipart/form-data"`: Expects FormData body (for file uploads), use `ctx.formData()` in handler
   *
   * The server will reject requests with mismatched Content-Type headers.
   *
   * @default "application/json"
   */
  contentType?: RouteContentType;
  inputSchema?: TInputSchema;
  outputSchema?: TOutputSchema;
  errorCodes?: readonly TErrorCode[];
  queryParameters?: readonly TQueryParameters[];
  handler(
    this: TThisContext,
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
  TThisContext extends RequestThisContext = RequestThisContext,
>(
  route: FragnoRouteConfig<
    TMethod,
    ValidPath<TPath>,
    undefined,
    TOutputSchema,
    TErrorCode,
    TQueryParameters,
    TThisContext
  > & { inputSchema?: undefined },
): FragnoRouteConfig<
  TMethod,
  TPath,
  undefined,
  TOutputSchema,
  TErrorCode,
  TQueryParameters,
  TThisContext
>;

// Overload for routes with inputSchema
export function addRoute<
  TMethod extends HTTPMethod,
  TPath extends string,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1 | undefined,
  TErrorCode extends string = string,
  TQueryParameters extends string = string,
  TThisContext extends RequestThisContext = RequestThisContext,
>(
  route: FragnoRouteConfig<
    TMethod,
    ValidPath<TPath>,
    TInputSchema,
    TOutputSchema,
    TErrorCode,
    TQueryParameters,
    TThisContext
  > & {
    inputSchema: TInputSchema;
  },
): FragnoRouteConfig<
  TMethod,
  TPath,
  TInputSchema,
  TOutputSchema,
  TErrorCode,
  TQueryParameters,
  TThisContext
>;

// Implementation
export function addRoute<
  TMethod extends HTTPMethod,
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined,
  TErrorCode extends string = string,
  TQueryParameters extends string = string,
  TThisContext extends RequestThisContext = RequestThisContext,
>(
  route: FragnoRouteConfig<
    TMethod,
    ValidPath<TPath>,
    TInputSchema,
    TOutputSchema,
    TErrorCode,
    TQueryParameters,
    TThisContext
  >,
): FragnoRouteConfig<
  TMethod,
  TPath,
  TInputSchema,
  TOutputSchema,
  TErrorCode,
  TQueryParameters,
  TThisContext
> {
  return route;
}

export { FragnoApiError, FragnoApiValidationError } from "./error";
export { createRouteCaller, type RouteCallerConfig } from "./route-caller";
export type { RouteHandlerInputOptions } from "./route-handler-input-options";
export type { FragnoPublicConfig } from "./shared-types";
