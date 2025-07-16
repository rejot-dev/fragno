// TODO(Wilco): Not currently used

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" | string;

/**
 * Builds a composite key from the HTTP method and the path (e.g. "GET /users").
 * We purposefully keep the separator a single space because that makes the
 * resulting keys easy to read and type-safe thanks to template-literal types.
 */
export type RouteKey<M extends string, P extends string> = `${M} ${P}`;

/**
 * A type-safe, immutable router that maps HTTP method & path pairs to arbitrary
 * route-specific metadata. Every call to {@link Router.addRoute} returns a new
 * router instance whose type parameter has been widened to include the newly
 * added route, guaranteeing that {@link Router.findRoute} returns exactly the
 * same type that was provided when the route was registered.
 *
 * Example usage:
 *
 * const router = new Router()
 *   .addRoute("GET", "/hello", { greeting: "world" })
 *   .addRoute("POST", "/hello", async (ctx) => {
 *     // handler implementation
 *   });
 *
 * // The type of `data` is inferred as `{ greeting: string }` because it matches
 * // the type that was passed to the corresponding `addRoute` call.
 * const data = router.findRoute("GET", "/hello");
 */

export class Router<Routes extends Record<string, unknown> = Record<never, never>> {
  private readonly store = new Map<string, unknown>();

  private static makeKey(method: string, path: string) {
    return `${method.toUpperCase()} ${path}`;
  }

  /**
   * Registers a new route and returns *a new* router instance whose route map
   * includes the newly registered route. The original router remains
   * unchanged, which makes it possible to safely reuse intermediate router
   * instances while preserving full type information.
   */
  addRoute<M extends string, P extends string, T>(
    method: M,
    path: P,
    data: T,
  ): Router<Routes & { [K in RouteKey<M, P>]: T }> {
    const key = Router.makeKey(method, path);
    const next = new Router<Routes & { [K in RouteKey<M, P>]: T }>();

    // Copy existing routes into the next router's store so that runtime lookups
    // continue to work.
    for (const [k, v] of this.store) {
      next.store.set(k, v);
    }

    next.store.set(key, data);

    // TypeScript cannot infer that `next` is compatible with the return type,
    // so we assert here. The runtime structure is correct because we fully
    // control `next`'s creation.
    return next as unknown as Router<Routes & { [K in RouteKey<M, P>]: T }>;
  }

  /**
   * Finds a previously registered route. When the `method` and `path`
   * arguments are string literals that correspond to a route that was added
   * via {@link addRoute}, the return type will be narrowed to exactly the type
   * that was provided for that route; otherwise it resolves to `unknown`.
   */
  findRoute<M extends string, P extends string>(
    method: M,
    path: P,
  ): Routes extends never
    ? never
    : RouteKey<M, P> extends keyof Routes
      ? Routes[RouteKey<M, P>]
      : unknown {
    const key = Router.makeKey(method, path);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.store.get(key) as any;
  }
}

/**
 * Convenience function that creates a new router instance while preserving
 * type inference for the caller.
 */
export function createRouter() {
  return new Router();
}

export function addRoute<M extends string, P extends string, T, R extends Record<string, unknown>>(
  router: Router<R>,
  method: M,
  path: P,
  data: T,
): Router<R & { [K in RouteKey<M, P>]: T }> {
  return router.addRoute(method, path, data);
}

export function findRoute<M extends string, P extends string, R extends Record<string, unknown>>(
  router: Router<R>,
  method: M,
  path: P,
): R extends never ? never : RouteKey<M, P> extends keyof R ? R[RouteKey<M, P>] : unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return router.findRoute(method, path) as any;
}
