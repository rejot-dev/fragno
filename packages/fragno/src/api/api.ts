import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ExtractPathParams } from "./internal/path-type";

export type HTTPMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" | string;

type InferOrVoid<T> =
  T extends NonNullable<StandardSchemaV1>
    ? StandardSchemaV1.InferOutput<T>
    : T extends undefined
      ? void
      : void;

export type RequestContext<
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined,
> = {
  path: TPath;
  req: Request;
  pathParams: ExtractPathParams<TPath>;
} & (TInputSchema extends undefined
  ? Record<string, never>
  : {
      input: {
        schema: TInputSchema;
        valid: () => Promise<
          TInputSchema extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<TInputSchema> : never
        >;
      };
    }) &
  (TOutputSchema extends undefined
    ? Record<string, never>
    : {
        output: {
          schema: TOutputSchema;
        };
      });

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
    ctx: RequestContext<TPath, TInputSchema, TOutputSchema>,
  ): Promise<InferOrVoid<NoInfer<TOutputSchema>>>;
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
