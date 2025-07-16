import { addRoute, createRouter, findRoute } from "rou3";
import { FragnoApiError, FragnoApiValidationError, type FragnoRouteConfig } from "./api/api";
import type { FragnoClientHook } from "./client/client";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ExtractPathParams } from "./api/internal/path-type";

export interface FragnoLibrarySharedConfig<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TRoutes extends readonly FragnoRouteConfig<string, any, any>[] = readonly FragnoRouteConfig<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  >[],
> {
  name: string;
  mountRoute?: string;
  routes: TRoutes;
}

export interface FragnoPublicClientConfig {
  baseUrl?: string;
}

export interface FragnoLibraryClientConfig {
  hooks: Record<string, FragnoClientHook>;
}

export interface FragnoInstantiatedLibrary {
  config: FragnoLibrarySharedConfig;
  handler: (req: Request) => Promise<Response>;
}

function getMountRoute(config: FragnoLibrarySharedConfig) {
  const mountRoute = config.mountRoute ?? `/api/${config.name}`;

  if (mountRoute.endsWith("/")) {
    return mountRoute.slice(0, -1);
  }

  return mountRoute;
}

export function createLibrary(config: FragnoLibrarySharedConfig): FragnoInstantiatedLibrary {
  const mountRoute = getMountRoute(config);
  // Allow routes to declare undefined schemas so the RequestContext accurately reflects the presence or absence of `input`/`output`.
  const router =
    createRouter<
      FragnoRouteConfig<string, StandardSchemaV1 | undefined, StandardSchemaV1 | undefined>
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
        req,
        pathParams: (route.params ?? {}) as ExtractPathParams<typeof route.data.path>,
        ...(inputSchema
          ? {
              input: {
                schema: inputSchema,
                valid: async () => {
                  const json = await req.json();
                  const result = await inputSchema!["~standard"].validate(json);

                  console.log("validating", json, result);

                  if (result.issues) {
                    throw new FragnoApiValidationError("Validation failed", result.issues);
                  }

                  return result.value;
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
        return await handler(ctx);
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

export function createLibraryClient(
  _publicConfig: FragnoPublicClientConfig,
  _sharedConfig: FragnoLibrarySharedConfig,
  _clientConfig: FragnoLibraryClientConfig,
) {}
