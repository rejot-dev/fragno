import {
  createRequestHandler,
  matchRoutes,
  type RouteObject,
  type ServerBuild,
} from "react-router";

type ServerRoute = NonNullable<ServerBuild["routes"][string]>;
type ServerRouteModule = ServerRoute["module"];
type RequestHandler = ReturnType<typeof createRequestHandler>;

/**
 * Production builds replace each route module but root's in the server build with this loader, so
 * a cold Worker only compiles the routes its requests match. See `lazyServerRouteModulesPlugin`.
 */
export const LOAD_ROUTE_MODULE = "__backofficeLoadRouteModule";

/**
 * A request handler that imports the route modules a request matches before React Router handles
 * it. React Router reads every route module when it builds its handler, so each time more modules
 * are loaded, the handler is rebuilt from those loaded so far; routes not yet loaded have no
 * exports, and no request reaches them until they are.
 */
export function createLazyRequestHandler(build: ServerBuild, mode?: string): RequestHandler {
  const loaders = new Map<string, () => Promise<ServerRouteModule>>();
  const loaded = new Map<string, ServerRouteModule>();
  for (const route of Object.values(build.routes)) {
    if (!route) {
      continue;
    }
    const load = (route.module as unknown as Record<string, unknown>)[LOAD_ROUTE_MODULE];
    if (typeof load === "function") {
      loaders.set(route.id, load as () => Promise<ServerRouteModule>);
    } else {
      loaded.set(route.id, route.module);
    }
  }
  // The dev server and tests import route modules as usual.
  if (loaders.size === 0) {
    return createRequestHandler(build, mode);
  }

  const routeTree = toMatchRoutes(build.routes);
  const loading = new Map<string, Promise<void>>();
  let handler: RequestHandler | undefined;
  let handlerRouteCount = -1;

  const load = (routeId: string) => {
    let promise = loading.get(routeId);
    if (!promise) {
      promise = loaders.get(routeId)!()
        .then((module) => {
          loaded.set(routeId, module);
        })
        .catch((error: unknown) => {
          loading.delete(routeId);
          throw error;
        });
      loading.set(routeId, promise);
    }
    return promise;
  };

  return async (request, loadContext) => {
    const routeIds = (matchRoutes(routeTree, normalizedPathname(request), build.basename) ?? [])
      .map((match) => match.route.id)
      .filter((routeId): routeId is string => routeId !== undefined && !loaded.has(routeId));
    await Promise.all(routeIds.map(load));
    if (!handler || handlerRouteCount !== loaded.size) {
      handlerRouteCount = loaded.size;
      handler = createRequestHandler(withLoadedRouteModules(build, loaded), mode);
    }
    return await handler(request, loadContext);
  };
}

function withLoadedRouteModules(
  build: ServerBuild,
  loaded: ReadonlyMap<string, ServerRouteModule>,
): ServerBuild {
  const routes: ServerBuild["routes"] = {};
  for (const [routeId, route] of Object.entries(build.routes)) {
    if (route) {
      routes[routeId] = { ...route, module: loaded.get(route.id) ?? ({} as ServerRouteModule) };
    }
  }
  return { ...build, routes };
}

/** The route tree React Router matches requests against, without the route modules. */
function toMatchRoutes(routes: ServerBuild["routes"], parentId?: string): RouteObject[] {
  return Object.values(routes)
    .filter((route): route is ServerRoute => route !== undefined && route.parentId === parentId)
    .map((route) =>
      route.index
        ? { id: route.id, path: route.path, index: true }
        : {
            id: route.id,
            path: route.path,
            caseSensitive: route.caseSensitive,
            children: toMatchRoutes(routes, route.id),
          },
    );
}

/** The path React Router matches a request by, without the `.data` suffix of data requests. */
function normalizedPathname(request: Request): string {
  const { pathname } = new URL(request.url);
  return pathname.endsWith("/_.data")
    ? pathname.replace(/_\.data$/, "")
    : pathname.replace(/\.data$/, "");
}
