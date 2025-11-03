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

/**
 * Base ServiceContext interface. Can be augmented by packages like @fragno-dev/db.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RequestThisContext {}

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
export type { RouteHandlerInputOptions } from "./route-handler-input-options";
