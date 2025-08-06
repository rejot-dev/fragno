import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ExtractPathParams } from "./internal/path-type";

export type RequestContext<
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined = undefined,
  TOutputSchema extends StandardSchemaV1 | undefined = undefined,
> = {
  req: Request;
  pathParams: ExtractPathParams<TPath>;
} & (TInputSchema extends StandardSchemaV1
  ? {
      input: {
        schema: TInputSchema;
        valid: () => Promise<StandardSchemaV1.InferOutput<TInputSchema>>;
      };
    }
  : object) &
  (TOutputSchema extends StandardSchemaV1
    ? {
        output: {
          schema: TOutputSchema;
        };
      }
    : object);

export interface FragnoRouteConfig<
  TPath extends string = string,
  TInputSchema extends StandardSchemaV1 | undefined = undefined,
  TOutputSchema extends StandardSchemaV1 | undefined = undefined,
> {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" | string;
  path: TPath;
  inputSchema?: TInputSchema;
  outputSchema?: TOutputSchema;
  handler: (ctx: RequestContext<TPath, TInputSchema, TOutputSchema>) => Promise<Response>;
}

export function addRoute<
  TPath extends string,
  TInputSchema extends StandardSchemaV1 | undefined = undefined,
  TOutputSchema extends StandardSchemaV1 | undefined = undefined,
>(
  route: FragnoRouteConfig<TPath, TInputSchema, TOutputSchema>,
): FragnoRouteConfig<TPath, TInputSchema, TOutputSchema> {
  return route;
}

export { FragnoApiError, FragnoApiValidationError } from "./error";
