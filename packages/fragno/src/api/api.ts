import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { RequestInputContext } from "./request-input-context";
import type { RequestOutputContext } from "./request-output-context";

export type HTTPMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";
export type NonGetHTTPMethod = Exclude<HTTPMethod, "GET">;

// TODO(Wilco): Add Query parameters to this object
export interface FragnoRouteConfig<
  TMethod extends HTTPMethod,
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined,
> {
  method: TMethod;
  path: TPath;
  inputSchema?: TInputSchema;
  outputSchema?: TOutputSchema;
  handler(
    inputCtx: RequestInputContext<TPath, TInputSchema>,
    outputCtx: RequestOutputContext<TOutputSchema>,
  ): Promise<Response>;
}

// Overload for routes without inputSchema
export function addRoute<
  TMethod extends HTTPMethod,
  TPath extends string,
  TOutputSchema extends StandardSchemaV1 | undefined,
>(
  route: FragnoRouteConfig<TMethod, TPath, undefined, TOutputSchema> & { inputSchema?: undefined },
): FragnoRouteConfig<TMethod, TPath, undefined, TOutputSchema>;

// Overload for routes with inputSchema
export function addRoute<
  TMethod extends HTTPMethod,
  TPath extends string,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1 | undefined,
>(
  route: FragnoRouteConfig<TMethod, TPath, TInputSchema, TOutputSchema> & {
    inputSchema: TInputSchema;
  },
): FragnoRouteConfig<TMethod, TPath, TInputSchema, TOutputSchema>;

// Implementation
export function addRoute<
  TMethod extends HTTPMethod,
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined,
>(
  route: FragnoRouteConfig<TMethod, TPath, TInputSchema, TOutputSchema>,
): FragnoRouteConfig<TMethod, TPath, TInputSchema, TOutputSchema> {
  return route;
}

export { FragnoApiError, FragnoApiValidationError } from "./error";
