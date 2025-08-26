import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { RequestInputContext } from "./request-input-context";
import type { RequestOutputContext } from "./request-output-context";

export type HTTPMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";
export type NonGetHTTPMethod = Exclude<HTTPMethod, "GET">;

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
    TPath,
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
    TPath,
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
    TPath,
    TInputSchema,
    TOutputSchema,
    TErrorCode,
    TQueryParameters
  >,
): FragnoRouteConfig<TMethod, TPath, TInputSchema, TOutputSchema, TErrorCode, TQueryParameters> {
  return route;
}

export { FragnoApiError, FragnoApiValidationError } from "./error";
