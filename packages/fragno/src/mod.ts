import { addRoute, createRouter, findRoute } from "rou3";
import {
  FragnoApiError,
  FragnoApiValidationError,
  type FragnoRouteConfig,
  type HTTPMethod,
} from "./api/api";
import type {
  FragnoClientHook,
  ExtractGetRoutes,
  ExtractGetRoutePaths,
  ExtractOutputSchemaForPath,
  IsValidGetRoutePath,
  GenerateHookTypeForPath,
  ValidateGetRoutePath,
  HasGetRoutes,
} from "./client/client";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ExtractPathParams } from "./api/internal/path";
import { getMountRoute } from "./api/internal/route";

export interface FragnoLibrarySharedConfig<
  TRoutes extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined
  >[],
> {
  name: string;
  routes: TRoutes;
}

export type AnyFragnoLibrarySharedConfig = FragnoLibrarySharedConfig<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly FragnoRouteConfig<HTTPMethod, string, any, any>[]
>;

export interface FragnoPublicConfig {
  mountRoute?: string;
}

export interface FragnoPublicClientConfig {
  mountRoute?: string;
  baseUrl?: string;
}

export interface FragnoInstantiatedLibrary<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TRoutes extends readonly FragnoRouteConfig<HTTPMethod, string, any, any>[],
> {
  config: FragnoLibrarySharedConfig<TRoutes>;
  handler: (req: Request) => Promise<Response>;
}

export function createLibrary<
  TRoutes extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined
  >[],
>(
  publicConfig: FragnoPublicConfig,
  config: FragnoLibrarySharedConfig<TRoutes>,
): FragnoInstantiatedLibrary<TRoutes> {
  const mountRoute = getMountRoute({
    name: config.name,
    mountRoute: publicConfig.mountRoute,
  });

  // Allow routes to declare undefined schemas so the RequestContext accurately reflects the presence or absence of `input`/`output`.
  const router =
    createRouter<
      FragnoRouteConfig<
        HTTPMethod,
        string,
        StandardSchemaV1 | undefined,
        StandardSchemaV1 | undefined
      >
    >();

  for (const routeConfig of config.routes) {
    addRoute(router, routeConfig.method.toUpperCase(), routeConfig.path, routeConfig);
  }

  return {
    config,
    handler: async (req: Request) => {
      const url = new URL(req.url);
      const pathname = url.pathname;

      // Remove the mount route from the pathname, then lookup the route based on that.
      const matchRoute = pathname.startsWith(mountRoute) ? pathname.slice(mountRoute.length) : null;

      if (matchRoute === null) {
        return new Response(
          `Fragno: Route for '${config.name}' not found. Is the library mounted on the right route? ` +
            `Expecting: '${mountRoute}'.`,
          { status: 404 },
        );
      }

      const route = findRoute(router, req.method, matchRoute);

      if (!route) {
        return new Response(`Fragno: Route for '${config.name}' not found`, { status: 404 });
      }

      const { handler, inputSchema, outputSchema } = route.data;

      const ctx = {
        request: req,
        searchParams: new URL(req.url).searchParams,
        path: route.data.path,
        // TODO(Wilco): Check if the params object actually aligns with the type here.
        pathParams: (route.params ?? {}) as ExtractPathParams<typeof route.data.path>,
        ...(inputSchema
          ? {
              input: {
                schema: inputSchema,
                valid: async () => {
                  try {
                    const json = await req.json();
                    const result = await inputSchema["~standard"].validate(json);

                    console.log("validating", json, result);

                    if (result.issues) {
                      throw new FragnoApiValidationError("Validation failed", result.issues);
                    }

                    return result.value;
                  } catch (error) {
                    if (error instanceof SyntaxError) {
                      throw new FragnoApiValidationError("Validation failed", [
                        {
                          message: "Request body is not valid JSON",
                        },
                      ]);
                    }

                    throw error;
                  }
                },
              },
            }
          : {}),
        ...(outputSchema
          ? {
              output: {
                schema: outputSchema,
              },
            }
          : {}),
      };

      try {
        const result = await handler(ctx);

        if (outputSchema) {
          return Response.json(result);
        }

        return new Response();
      } catch (error) {
        console.error(error);

        if (error instanceof FragnoApiError) {
          return error.toResponse();
        }

        return Response.json({ error: "Internal server error" }, { status: 500 });
      }
    },
  };
}

// Re-export client utility types and builder
export type {
  FragnoClientHook,
  ExtractGetRoutes,
  ExtractGetRoutePaths,
  ExtractOutputSchemaForPath,
  IsValidGetRoutePath,
  GenerateHookTypeForPath,
  ValidateGetRoutePath,
  HasGetRoutes,
};

export { createClientBuilder, createLibraryHook } from "./client/client";
export { toNextJsHandler } from "./integrations/next-js";
