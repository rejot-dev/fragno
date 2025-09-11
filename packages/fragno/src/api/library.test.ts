import { test, expect, describe, expectTypeOf } from "vitest";
import { defineLibrary, createLibrary, type LibraryBuilder } from "./library";
import { defineRoute, defineRoutes, type RouteFactory, resolveRouteFactories } from "./route";
import { z } from "zod";
import type { InferOr } from "../util/types-util";

type Empty = Record<never, never>;

describe("new-library API", () => {
  describe("Type inference", () => {
    test("defineLibrary infers config type correctly", () => {
      const _config = {
        apiKey: "test-key",
        maxRetries: 3,
        debug: false,
      };

      const _library = defineLibrary<typeof _config>("test");

      expectTypeOf<typeof _library>().toEqualTypeOf<
        LibraryBuilder<
          {
            apiKey: string;
            maxRetries: number;
            debug: boolean;
          },
          Empty,
          Empty
        >
      >();
    });

    test("withDependencies correctly transforms dependency types", () => {
      const _config = {
        apiKey: "test-key",
      };

      const _library = defineLibrary<typeof _config>("test").withDependencies((cfg) => {
        expectTypeOf(cfg).toEqualTypeOf<typeof _config>();
        return {
          httpClient: { fetch: () => Promise.resolve(new Response()) },
          logger: { log: (msg: string) => console.log(msg) },
        };
      });

      expectTypeOf<typeof _library>().toEqualTypeOf<
        LibraryBuilder<
          typeof _config,
          {
            httpClient: { fetch: () => Promise<Response> };
            logger: { log: (msg: string) => void };
          },
          Empty
        >
      >();
    });

    test("withServices has access to dependencies and config", () => {
      const _config = {
        apiKey: "test-key",
        baseUrl: "https://api.example.com",
      };

      const _library = defineLibrary<typeof _config>("test")
        .withDependencies((cfg) => {
          expectTypeOf(cfg).toEqualTypeOf<{
            apiKey: string;
            baseUrl: string;
          }>();

          return { httpClient: { baseUrl: cfg.baseUrl } };
        })
        .withServices((cfg, deps) => {
          expectTypeOf(cfg).toEqualTypeOf<typeof _config>();
          expectTypeOf(deps).toEqualTypeOf<{ httpClient: { baseUrl: string } }>();

          return {
            userService: {
              getUser: async (id: string) => ({ id, name: "Test User" }),
            },
            cacheService: {
              get: (_key: string): string => crypto.randomUUID(),
              set: (_key: string, _value: string) => {},
            },
          };
        });

      expectTypeOf<typeof _library>().toEqualTypeOf<
        LibraryBuilder<
          typeof _config,
          { httpClient: { baseUrl: string } },
          {
            userService: {
              getUser: (id: string) => Promise<{ id: string; name: string }>;
            };
            cacheService: {
              get: (key: string) => string;
              set: (key: string, value: string) => void;
            };
          }
        >
      >();
    });

    test("defineRoutes receives correct context types", () => {
      type Config = {
        apiKey: string;
        model: "gpt-3" | "gpt-4";
      };

      type Deps = {
        openai: { complete: (prompt: string) => Promise<string> };
      };

      type Services = {
        cache: Map<string, unknown>;
      };

      const _routeFactory = defineRoutes<Config, Deps, Services>()(({ config, deps, services }) => {
        expectTypeOf(config).toEqualTypeOf<Config>();
        expectTypeOf(deps).toEqualTypeOf<Deps>();
        expectTypeOf(services).toEqualTypeOf<Services>();

        return [
          defineRoute({
            method: "POST",
            path: "/complete",
            inputSchema: z.object({ prompt: z.string() }),
            outputSchema: z.object({ result: z.string() }),
            handler: async ({ input }, { json }) => {
              const { prompt } = await input.valid();
              expectTypeOf(prompt).toEqualTypeOf<string>();
              expectTypeOf<Parameters<typeof json>[0]>().toEqualTypeOf<{ result: string }>();

              const result = await deps.openai.complete(prompt);
              services.cache.set(prompt, result);
              return json({ result });
            },
          }),
        ];
      });

      expectTypeOf<Parameters<typeof _routeFactory>[0]>().toEqualTypeOf<{
        config: Config;
        deps: Deps;
        services: Services;
      }>();
    });
  });

  describe("Builder pattern", () => {
    test("Builder methods return new instances", () => {
      const _config = { test: true };

      const lib1 = defineLibrary<typeof _config>("test");
      expectTypeOf(lib1).toEqualTypeOf<LibraryBuilder<typeof _config, Empty, Empty>>();

      const lib2 = lib1.withDependencies(() => ({ dep1: "value1" }));
      expectTypeOf(lib2).toEqualTypeOf<LibraryBuilder<typeof _config, { dep1: string }, Empty>>();
      const lib3 = lib2.withServices(() => ({ service1: "value1" }));
      expectTypeOf(lib3).toEqualTypeOf<
        LibraryBuilder<typeof _config, { dep1: string }, { service1: string }>
      >();

      expect(lib1).not.toBe(lib2);
      expect(lib2).not.toBe(lib3);
      expect(lib1).not.toBe(lib3);
    });

    test("Each builder step preserves previous configuration", () => {
      const _config = { apiKey: "test" };

      const library = defineLibrary<typeof _config>("my-lib")
        .withDependencies((_cfg) => ({
          client: `Client for ${_cfg.apiKey}`,
        }))
        .withServices((_cfg, deps) => ({
          service: `Service using ${deps.client}`,
        }));

      expect(library.definition.name).toBe("my-lib");
      expect(library.definition.dependencies).toBeDefined();
      expect(library.definition.services).toBeDefined();
    });
  });

  describe("Library creation", () => {
    test("createLibrary instantiates library with config", async () => {
      const InputSchema = z.object({ name: z.string() });
      const OutputSchema = z.object({ greeting: z.string() });

      const routeFactory = defineRoutes<
        { prefix: string },
        { formatter: (s: string) => string },
        { logger: { log: (s: string) => void } }
      >()(({ config, deps, services }) => [
        defineRoute({
          method: "POST",
          path: "/greet",
          inputSchema: InputSchema,
          outputSchema: OutputSchema,
          handler: async ({ input }, { json }) => {
            const { name } = await input.valid();
            const greeting = deps.formatter(`${config.prefix} ${name}`);
            services.logger.log(greeting);
            return json({ greeting });
          },
        }),
      ]);

      const libraryDef = defineLibrary("greeting")
        .withDependencies((_config) => ({
          formatter: (s: string) => s.toUpperCase(),
        }))
        .withServices(() => ({
          logger: { log: (s: string) => console.log(s) },
        }));

      const library = createLibrary(libraryDef, { prefix: "Hello" }, [routeFactory], {});

      expect(library.mountRoute).toBe("/api/greeting");
      expect(library.config.name).toBe("greeting");
      expect(library.services).toHaveProperty("logger");
      expect(library.handler).toBeInstanceOf(Function);

      const request = new Request("http://localhost/api/greeting/greet", {
        method: "POST",
        body: JSON.stringify({ name: "World" }),
        headers: { "Content-Type": "application/json" },
      });

      const response = await library.handler(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toEqual({ greeting: "HELLO WORLD" });
    });

    test("Wildcard path", async () => {
      const route = defineRoute({
        method: "GET",
        path: "/thing/:id/**:path",
        handler: async ({ pathParams: _pathParams }, outputCtx) => {
          expectTypeOf<typeof _pathParams>().toEqualTypeOf<{ id: string; path: string }>();
          return outputCtx.json({ message: "Hello, World!" });
        },
      });

      const libraryDef = defineLibrary("test-library");
      const library = createLibrary(libraryDef, {}, [route], {
        mountRoute: "/api",
      });

      // Create a test request
      const request = new Request("http://localhost:3000/api/thing/123/foo/bar", {
        method: "GET",
      });

      // Call the handler
      const response = await library.handler(request);

      // Verify the response
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ message: "Hello, World!" });
    });

    test("Routes receive correct context from library definition", async () => {
      let capturedConfig;
      let capturedDeps;
      let capturedServices;

      const routeFactory = defineRoutes<
        { setting: string },
        { tool: string },
        { storage: string }
      >()(({ config, deps, services }) => {
        capturedConfig = config;
        capturedDeps = deps;
        capturedServices = services;
        return [
          defineRoute({
            method: "GET",
            path: "/test",
            handler: async (_, { json }) => json({ ok: true }),
          }),
        ];
      });

      const libraryDef = defineLibrary("test")
        .withDependencies(() => ({ tool: "hammer" }))
        .withServices(() => ({ storage: "memory" }));

      createLibrary(libraryDef, { setting: "value" }, [routeFactory], {});

      expect(capturedConfig).toEqual({ setting: "value" });
      expect(capturedDeps).toEqual({ tool: "hammer" });
      expect(capturedServices).toEqual({ storage: "memory" });
    });
  });

  describe("Type constraints", () => {
    test("Services must extend Record<string, unknown>", () => {
      const libraryDef = defineLibrary("test").withServices(() => ({
        validService: { method: () => {} },
        anotherService: "string value",
        numberService: 123,
      }));

      const _library = createLibrary(libraryDef, {}, [], {});

      expectTypeOf<typeof _library.services>().toEqualTypeOf<{
        validService: { method: () => void };
        anotherService: string;
        numberService: number;
      }>();
    });

    test("Route handler types are preserved", () => {
      const OutputSchema = z.object({ data: z.string() });

      const route = defineRoute({
        method: "GET",
        path: "/item/:id",
        inputSchema: z.object({ id: z.number() }),
        outputSchema: OutputSchema,
        errorCodes: ["NOT_FOUND"],
        queryParameters: ["page", "limit"],
        handler: async ({ pathParams, input }, { json }) => {
          expectTypeOf(pathParams).toEqualTypeOf<{ id: string }>();
          const validated = await input.valid();
          expectTypeOf(validated).toEqualTypeOf<{ id: number }>();
          return json({ data: "test" });
        },
      });
      expectTypeOf(route.method).toEqualTypeOf<"GET">();
      expectTypeOf(route.path).toEqualTypeOf<"/item/:id">();
      expectTypeOf<InferOr<typeof route.inputSchema, undefined>>().toEqualTypeOf<
        { id: number } | undefined
      >();
      expectTypeOf(route.outputSchema).toEqualTypeOf<typeof OutputSchema | undefined>();
      expectTypeOf(route.errorCodes).toEqualTypeOf<readonly "NOT_FOUND"[] | undefined>();
      expectTypeOf(route.queryParameters).toEqualTypeOf<
        readonly ("page" | "limit")[] | undefined
      >();
    });
  });

  describe("resolveRouteFactories", () => {
    test("resolveRouteFactories returns correct routes", () => {
      const routeFactory = defineRoutes()(() => {
        const firstRoute = defineRoute({
          method: "GET",
          path: "/first",
          inputSchema: z.object({ id: z.string() }),
          outputSchema: z.object({ ok: z.boolean() }),
          errorCodes: ["FIRST_NOT_FOUND"],
          queryParameters: ["page", "limit"],
          handler: async (_, { json }) => json({ ok: true }),
        });

        return [
          firstRoute,
          defineRoute({
            method: "POST",
            path: "/second",
            inputSchema: z.object({ id: z.string() }),
            outputSchema: z.object({ ok: z.boolean() }),
            errorCodes: ["SECOND_NOT_FOUND"],
            queryParameters: ["page", "limit"],
            handler: async (_, { json }) => json({ ok: true }),
          }),
        ];
      });

      type RouteFactoryRoutes =
        typeof routeFactory extends RouteFactory<infer _T1, infer _T2, infer _T3, infer TRoutes>
          ? TRoutes
          : never;

      expectTypeOf<RouteFactoryRoutes[0]["path"]>().toEqualTypeOf<"/first">();
      expectTypeOf<RouteFactoryRoutes[0]["method"]>().toEqualTypeOf<"GET">();
      expectTypeOf<RouteFactoryRoutes[0]["errorCodes"]>().toEqualTypeOf<
        readonly "FIRST_NOT_FOUND"[] | undefined
      >();
      expectTypeOf<RouteFactoryRoutes[0]["queryParameters"]>().toEqualTypeOf<
        readonly ("page" | "limit")[] | undefined
      >();

      expectTypeOf<RouteFactoryRoutes[1]["path"]>().toEqualTypeOf<"/second">();
      expectTypeOf<RouteFactoryRoutes[1]["method"]>().toEqualTypeOf<"POST">();
      expectTypeOf<RouteFactoryRoutes[1]["errorCodes"]>().toEqualTypeOf<
        readonly "SECOND_NOT_FOUND"[] | undefined
      >();
      expectTypeOf<RouteFactoryRoutes[1]["queryParameters"]>().toEqualTypeOf<
        readonly ("page" | "limit")[] | undefined
      >();

      const routes = resolveRouteFactories(
        {
          config: {},
          deps: {},
          services: {},
        },
        [routeFactory],
      );

      const [r1, r2] = routes;
      {
        const { path, method, errorCodes, queryParameters } = r1;
        expectTypeOf(path).toEqualTypeOf<"/first">();
        expectTypeOf(method).toEqualTypeOf<"GET">();
        expectTypeOf(errorCodes).toEqualTypeOf<readonly "FIRST_NOT_FOUND"[] | undefined>();
        expectTypeOf(queryParameters).toEqualTypeOf<readonly ("page" | "limit")[] | undefined>();

        expect(path).toBe("/first");
        expect(method).toBe("GET");
        expect(errorCodes).toEqual(["FIRST_NOT_FOUND"]);
        expect(queryParameters).toEqual(["page", "limit"]);
      }

      {
        const { path, method, errorCodes, queryParameters } = r2;
        expectTypeOf(path).toEqualTypeOf<"/second">();
        expectTypeOf(method).toEqualTypeOf<"POST">();
        expectTypeOf(errorCodes).toEqualTypeOf<readonly "SECOND_NOT_FOUND"[] | undefined>();
        expectTypeOf(queryParameters).toEqualTypeOf<readonly ("page" | "limit")[] | undefined>();

        expect(path).toBe("/second");
        expect(method).toBe("POST");
        expect(errorCodes).toEqual(["SECOND_NOT_FOUND"]);
        expect(queryParameters).toEqual(["page", "limit"]);
      }
    });

    test("defineRoutes preserves route types with explicit context types", () => {
      type Config = {
        apiKey: string;
        model: "gpt-3" | "gpt-4";
      };

      type Deps = {
        openai: { complete: (prompt: string) => Promise<string> };
      };

      type Services = {
        cache: Map<string, unknown>;
      };

      const routeFactory = defineRoutes<Config, Deps, Services>()(({ config, deps, services }) => {
        expectTypeOf(config).toEqualTypeOf<Config>();
        expectTypeOf(deps).toEqualTypeOf<Deps>();
        expectTypeOf(services).toEqualTypeOf<Services>();

        return [
          defineRoute({
            method: "POST",
            path: "/complete",
            inputSchema: z.object({ prompt: z.string() }),
            outputSchema: z.object({ result: z.string() }),
            errorCodes: ["RATE_LIMITED"],
            handler: async ({ input }, { json }) => {
              const { prompt } = await input.valid();
              const result = await deps.openai.complete(prompt);
              services.cache.set(prompt, result);
              return json({ result });
            },
          }),
          defineRoute({
            method: "GET",
            path: "/status",
            outputSchema: z.object({ status: z.literal("ok") }),
            handler: async (_, { json }) => json({ status: "ok" }),
          }),
        ];
      });

      type RouteFactoryRoutes =
        typeof routeFactory extends RouteFactory<infer _T1, infer _T2, infer _T3, infer TRoutes>
          ? TRoutes
          : never;

      expectTypeOf<RouteFactoryRoutes[0]["path"]>().toEqualTypeOf<"/complete">();
      expectTypeOf<RouteFactoryRoutes[0]["method"]>().toEqualTypeOf<"POST">();
      expectTypeOf<RouteFactoryRoutes[0]["errorCodes"]>().toEqualTypeOf<
        readonly "RATE_LIMITED"[] | undefined
      >();

      expectTypeOf<RouteFactoryRoutes[1]["path"]>().toEqualTypeOf<"/status">();
      expectTypeOf<RouteFactoryRoutes[1]["method"]>().toEqualTypeOf<"GET">();

      const routes = resolveRouteFactories(
        {
          config: { apiKey: "test", model: "gpt-4" as const },
          deps: { openai: { complete: async () => "result" } },
          services: { cache: new Map() },
        },
        [routeFactory],
      );

      expectTypeOf(routes[0].path).toEqualTypeOf<"/complete">();
      expectTypeOf(routes[1].path).toEqualTypeOf<"/status">();
    });
  });
});
