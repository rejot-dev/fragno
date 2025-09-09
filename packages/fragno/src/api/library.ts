import type { StandardSchemaV1 } from "@standard-schema/spec";
import { type FragnoRouteConfig, type HTTPMethod } from "./api";
import { FragnoApiError } from "./error";
import { getMountRoute } from "./internal/route";
import { addRoute, createRouter, findRoute } from "rou3";
import { RequestInputContext } from "./request-input-context";
import type { ExtractPathParams } from "./internal/path";
import { RequestOutputContext } from "./request-output-context";

export interface FragnoLibrarySharedConfig<
  TRoutes extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string,
    string
  >[],
> {
  name: string;
  routes: TRoutes;
}

export type AnyFragnoLibrarySharedConfig = FragnoLibrarySharedConfig<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly FragnoRouteConfig<HTTPMethod, string, any, any, any, any>[]
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
  TRoutes extends readonly FragnoRouteConfig<HTTPMethod, string, any, any, any, any>[] = [],
  TServices extends Record<string, unknown> = Record<string, unknown>,
> {
  config: FragnoLibrarySharedConfig<TRoutes>;
  services: TServices;
  handler: (req: Request) => Promise<Response>;
  mountRoute: string;
}

export function createLibrary<
  TRoutes extends readonly FragnoRouteConfig<
    HTTPMethod,
    string,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string,
    string
  >[],
  TServices extends Record<string, unknown> = Record<string, unknown>,
>(
  publicConfig: FragnoPublicConfig,
  config: FragnoLibrarySharedConfig<TRoutes>,
  services: TServices,
): FragnoInstantiatedLibrary<TRoutes, TServices> {
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
        StandardSchemaV1 | undefined,
        string,
        string
      >
    >();

  for (const routeConfig of config.routes) {
    addRoute(router, routeConfig.method.toUpperCase(), routeConfig.path, routeConfig);
  }

  return {
    mountRoute,
    config,
    services,
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

      const { handler, inputSchema, outputSchema, path } = route.data;

      const inputContext = await RequestInputContext.fromRequest({
        request: req,
        method: req.method,
        path,
        pathParams: (route.params ?? {}) as ExtractPathParams<typeof path>,
        inputSchema,
      });

      const outputContext = new RequestOutputContext(outputSchema);

      try {
        const result = await handler(inputContext, outputContext);
        return result;
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
