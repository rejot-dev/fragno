import { describe, it, expect } from "vitest";
import { createFragmentForTest } from "./test";
import { defineFragment } from "../api/fragment-builder";
import { defineRoute, defineRoutes } from "../api/route";
import { z } from "zod";

describe("createFragmentForTest", () => {
  it("should create a test fragment with config only", () => {
    const fragment = defineFragment<{ apiKey: string }>("test");
    const testFragment = createFragmentForTest(fragment, {
      config: { apiKey: "test-key" },
    });

    expect(testFragment.config).toEqual({ apiKey: "test-key" });
    expect(testFragment.deps).toEqual({});
    expect(testFragment.services).toEqual({});
  });

  it("should create deps from fragment definition", () => {
    const fragment = defineFragment<{ apiKey: string }>("test").withDependencies(({ config }) => ({
      client: { apiKey: config.apiKey },
    }));

    const testFragment = createFragmentForTest(fragment, {
      config: { apiKey: "test-key" },
    });

    expect(testFragment.deps).toEqual({ client: { apiKey: "test-key" } });
  });

  it("should override deps when provided", () => {
    const fragment = defineFragment<{ apiKey: string }>("test").withDependencies(({ config }) => ({
      client: { apiKey: config.apiKey },
    }));

    const testFragment = createFragmentForTest(fragment, {
      config: { apiKey: "test-key" },
      deps: { client: { apiKey: "override-key" } },
    });

    expect(testFragment.deps).toEqual({ client: { apiKey: "override-key" } });
  });

  it("should create services from fragment definition", () => {
    const fragment = defineFragment<{ apiKey: string }>("test")
      .withDependencies(({ config }) => ({
        client: { apiKey: config.apiKey },
      }))
      .withServices(({ deps }) => ({
        getApiKey: () => deps.client.apiKey,
      }));

    const testFragment = createFragmentForTest(fragment, {
      config: { apiKey: "test-key" },
    });

    expect(testFragment.services.getApiKey()).toBe("test-key");
  });

  it("should override services when provided", () => {
    const fragment = defineFragment<{ apiKey: string }>("test")
      .withDependencies(({ config }) => ({
        client: { apiKey: config.apiKey },
      }))
      .withServices(({ deps }) => ({
        getApiKey: () => deps.client.apiKey,
      }));

    const testFragment = createFragmentForTest(fragment, {
      config: { apiKey: "test-key" },
      services: { getApiKey: () => "override-key" },
    });

    expect(testFragment.services.getApiKey()).toBe("override-key");
  });

  it("should initialize routes with fragment context", () => {
    const fragment = defineFragment<{ multiplier: number }>("test")
      .withDependencies(() => ({ dep: "value" }))
      .withServices(({ config }) => ({
        multiply: (x: number) => x * config.multiplier,
      }));

    const testFragment = createFragmentForTest(fragment, {
      config: { multiplier: 2 },
    });

    const route = defineRoute({
      method: "GET",
      path: "/test",
      outputSchema: z.object({ result: z.number() }),
      handler: async (_ctx, { json }) => {
        return json({ result: 42 });
      },
    });

    const routes = [route] as const;
    const [initializedRoute] = testFragment.initRoutes(routes);

    expect(initializedRoute).toBe(route);
    expect(initializedRoute.method).toBe("GET");
    expect(initializedRoute.path).toBe("/test");
  });

  it("should initialize route factories with fragment context", async () => {
    const fragment = defineFragment<{ multiplier: number }>("test")
      .withDependencies(() => ({ dep: "value" }))
      .withServices(({ config }) => ({
        multiply: (x: number) => x * config.multiplier,
      }));

    const testFragment = createFragmentForTest(fragment, {
      config: { multiplier: 3 },
    });

    const routeFactory = ({ services }: { services: { multiply: (x: number) => number } }) => {
      return [
        defineRoute({
          method: "GET",
          path: "/multiply",
          outputSchema: z.object({ result: z.number() }),
          handler: async (_ctx, { json }) => {
            return json({ result: services.multiply(5) });
          },
        }),
      ];
    };

    const routes = [routeFactory] as const;
    const [multiplyRoute] = testFragment.initRoutes(routes);

    expect(multiplyRoute.method).toBe("GET");
    expect(multiplyRoute.path).toBe("/multiply");

    // Test that the route was initialized with the correct services
    const response = await testFragment.handler(multiplyRoute);
    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data).toEqual({ result: 15 }); // 5 * 3
    }
  });

  it("should allow overriding config/deps/services for specific route initialization", async () => {
    const fragment = defineFragment<{ multiplier: number }>("test")
      .withDependencies(() => ({ baseUrl: "https://api.example.com" }))
      .withServices(({ config }) => ({
        multiply: (x: number) => x * config.multiplier,
        getMessage: (): string => "original message",
      }));

    const testFragment = createFragmentForTest(fragment, {
      config: { multiplier: 2 },
    });

    const routeFactory = ({
      config,
      services,
    }: {
      config: { multiplier: number };
      services: { multiply: (x: number) => number; getMessage: () => string };
    }) => {
      return [
        defineRoute({
          method: "GET",
          path: "/test",
          outputSchema: z.object({
            result: z.number(),
            message: z.string(),
            multiplier: z.number(),
          }),
          handler: async (_ctx, { json }) => {
            return json({
              result: services.multiply(10),
              message: services.getMessage(),
              multiplier: config.multiplier,
            });
          },
        }),
      ];
    };

    const routes = [routeFactory] as const;

    // Initialize with overrides - completely replace the multiply service
    const [overriddenRoute] = testFragment.initRoutes(routes, {
      config: { multiplier: 5 },
      services: {
        multiply: (x: number) => x * 5, // Mock implementation uses hardcoded multiplier
        getMessage: (): string => "mocked message",
      },
    });

    const response = await testFragment.handler(overriddenRoute);
    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data).toEqual({
        result: 50, // 10 * 5 (mocked multiply service)
        message: "mocked message", // overridden service
        multiplier: 5, // overridden config
      });
    }

    // Verify original fragment config/services are unchanged
    expect(testFragment.config.multiplier).toBe(2);
    expect(testFragment.services.multiply(10)).toBe(20); // Original multiplier is 2
    expect(testFragment.services.getMessage()).toBe("original message");
  });
});

describe("fragment.handler", () => {
  it("should handle JSON response", async () => {
    const fragment = defineFragment<{ apiKey: string }>("test");
    const testFragment = createFragmentForTest(fragment, {
      config: { apiKey: "test-key" },
    });

    const route = defineRoute({
      method: "GET",
      path: "/test",
      outputSchema: z.object({ message: z.string() }),
      handler: async (_ctx, { json }) => {
        return json({ message: "hello" });
      },
    });

    const response = await testFragment.handler(route);

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ message: "hello" });
      expect(response.headers).toBeInstanceOf(Headers);
    }
  });

  it("should handle empty response", async () => {
    const fragment = defineFragment<{ apiKey: string }>("test");
    const testFragment = createFragmentForTest(fragment, {
      config: { apiKey: "test-key" },
    });

    const route = defineRoute({
      method: "DELETE",
      path: "/test",
      handler: async (_ctx, { empty }) => {
        return empty(204);
      },
    });

    const response = await testFragment.handler(route);

    expect(response.type).toBe("empty");
    if (response.type === "empty") {
      expect(response.status).toBe(204);
      expect(response.headers).toBeInstanceOf(Headers);
    }
  });

  it("should handle error response", async () => {
    const fragment = defineFragment<{ apiKey: string }>("test");
    const testFragment = createFragmentForTest(fragment, {
      config: { apiKey: "test-key" },
    });

    const route = defineRoute({
      method: "GET",
      path: "/test",
      errorCodes: ["NOT_FOUND"] as const,
      handler: async (_ctx, { error }) => {
        return error({ message: "Not found", code: "NOT_FOUND" }, 404);
      },
    });

    const response = await testFragment.handler(route);

    expect(response.type).toBe("error");
    if (response.type === "error") {
      expect(response.status).toBe(404);
      expect(response.error).toEqual({ message: "Not found", code: "NOT_FOUND" });
      expect(response.headers).toBeInstanceOf(Headers);
    }
  });

  it("should handle JSON stream response", async () => {
    const fragment = defineFragment<{ apiKey: string }>("test");
    const testFragment = createFragmentForTest(fragment, {
      config: { apiKey: "test-key" },
    });

    const route = defineRoute({
      method: "GET",
      path: "/test/stream",
      outputSchema: z.array(z.object({ value: z.number() })),
      handler: async (_ctx, { jsonStream }) => {
        return jsonStream(async (stream) => {
          for (let i = 1; i <= 5; i++) {
            await stream.write({ value: i });
          }
        });
      },
    });

    const response = await testFragment.handler(route);

    expect(response.type).toBe("jsonStream");
    if (response.type === "jsonStream") {
      expect(response.status).toBe(200);
      expect(response.headers).toBeInstanceOf(Headers);
      expect(response.headers.get("content-type")).toContain("application/x-ndjson");

      const items = [];
      for await (const item of response.stream) {
        items.push(item);
      }

      expect(items).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }, { value: 5 }]);
    }
  });

  it("should handle route factory created with defineRoutes", async () => {
    const fragment = defineFragment<{ apiKey: string }>("test").withServices(() => ({
      getGreeting: (name: string) => `Hello, ${name}!`,
      getCount: () => 42,
    }));

    const testFragment = createFragmentForTest(fragment, {
      config: { apiKey: "test-key" },
    });

    type Config = { apiKey: string };
    type Deps = {};
    type Services = { getGreeting: (name: string) => string; getCount: () => number };

    const routeFactory = defineRoutes<Config, Deps, Services>().create(({ services }) => [
      defineRoute({
        method: "GET",
        path: "/greeting/:name",
        outputSchema: z.object({ message: z.string() }),
        handler: async ({ pathParams }, { json }) => {
          return json({ message: services.getGreeting(pathParams.name) });
        },
      }),
      defineRoute({
        method: "GET",
        path: "/count",
        outputSchema: z.object({ count: z.number() }),
        handler: async (_ctx, { json }) => {
          return json({ count: services.getCount() });
        },
      }),
    ]);

    const routes = [routeFactory] as const;
    const [greetingRoute, countRoute] = testFragment.initRoutes(routes);

    // Test first route
    const greetingResponse = await testFragment.handler(greetingRoute, {
      pathParams: { name: "World" },
    });

    expect(greetingResponse.type).toBe("json");
    if (greetingResponse.type === "json") {
      expect(greetingResponse.data).toEqual({ message: "Hello, World!" });
    }

    // Test second route
    const countResponse = await testFragment.handler(countRoute);

    expect(countResponse.type).toBe("json");
    if (countResponse.type === "json") {
      expect(countResponse.data).toEqual({ count: 42 });
    }
  });

  it("should handle path parameters", async () => {
    const fragment = defineFragment<{}>("test");
    const testFragment = createFragmentForTest(fragment, {
      config: {},
    });

    const route = defineRoute({
      method: "GET",
      path: "/users/:id",
      outputSchema: z.object({ userId: z.string() }),
      handler: async ({ pathParams }, { json }) => {
        return json({ userId: pathParams.id });
      },
    });

    const response = await testFragment.handler(route, {
      pathParams: { id: "123" },
    });

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data).toEqual({ userId: "123" });
    }
  });

  it("should handle query parameters", async () => {
    const fragment = defineFragment<{}>("test");
    const testFragment = createFragmentForTest(fragment, {
      config: {},
    });

    const route = defineRoute({
      method: "GET",
      path: "/search",
      outputSchema: z.object({ query: z.string() }),
      handler: async ({ query }, { json }) => {
        return json({ query: query.get("q") || "" });
      },
    });

    const response = await testFragment.handler(route, {
      query: { q: "test" },
    });

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data).toEqual({ query: "test" });
    }
  });

  it("should handle request body", async () => {
    const fragment = defineFragment<{}>("test");
    const testFragment = createFragmentForTest(fragment, {
      config: {},
    });

    const route = defineRoute({
      method: "POST",
      path: "/users",
      inputSchema: z.object({ name: z.string(), email: z.string() }),
      outputSchema: z.object({ id: z.number(), name: z.string(), email: z.string() }),
      handler: async ({ input }, { json }) => {
        if (input) {
          const data = await input.valid();
          return json({ id: 1, name: data.name, email: data.email });
        }
        return json({ id: 1, name: "", email: "" });
      },
    });

    const response = await testFragment.handler(route, {
      body: { name: "John", email: "john@example.com" },
    });

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data).toEqual({ id: 1, name: "John", email: "john@example.com" });
    }
  });

  it("should handle custom headers", async () => {
    const fragment = defineFragment<{}>("test");
    const testFragment = createFragmentForTest(fragment, {
      config: {},
    });

    const route = defineRoute({
      method: "GET",
      path: "/test",
      outputSchema: z.object({ authHeader: z.string() }),
      handler: async ({ headers }, { json }) => {
        return json({ authHeader: headers.get("authorization") || "" });
      },
    });

    const response = await testFragment.handler(route, {
      headers: { authorization: "Bearer token" },
    });

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data).toEqual({ authHeader: "Bearer token" });
    }
  });

  it("should properly type path params", async () => {
    const fragment = defineFragment<{}>("test");
    const testFragment = createFragmentForTest(fragment, {
      config: {},
    });

    const route = defineRoute({
      method: "GET",
      path: "/orgs/:orgId/users/:userId",
      outputSchema: z.object({ orgId: z.string(), userId: z.string() }),
      handler: async ({ pathParams }, { json }) => {
        return json({ orgId: pathParams.orgId, userId: pathParams.userId });
      },
    });

    const response = await testFragment.handler(route, {
      pathParams: { orgId: "123", userId: "456" },
    });

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data).toEqual({ orgId: "123", userId: "456" });
    }
  });
});
