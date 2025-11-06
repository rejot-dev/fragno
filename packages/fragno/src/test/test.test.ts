import { describe, it, expect, expectTypeOf, assert } from "vitest";
import { createFragmentForTest } from "./test";
import { defineFragment } from "../api/fragment-builder";
import { defineRoute, defineRoutes } from "../api/route";
import { z } from "zod";

describe("createFragmentForTest", () => {
  it("should create a test fragment with config only", () => {
    const fragment = defineFragment<{ apiKey: string }>("test");
    const testFragment = createFragmentForTest(fragment, [], {
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

    const testFragment = createFragmentForTest(fragment, [], {
      config: { apiKey: "test-key" },
    });

    expect(testFragment.deps).toEqual({ client: { apiKey: "test-key" } });
  });

  it("should override deps when provided", () => {
    const fragment = defineFragment<{ apiKey: string }>("test").withDependencies(({ config }) => ({
      client: { apiKey: config.apiKey },
    }));

    const testFragment = createFragmentForTest(fragment, [], {
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
      .providesService(({ deps, defineService }) =>
        defineService({
          getApiKey: () => deps.client.apiKey,
        }),
      );

    const testFragment = createFragmentForTest(fragment, [], {
      config: { apiKey: "test-key" },
    });

    expect(testFragment.services.getApiKey()).toBe("test-key");
  });

  it("should override services when provided", () => {
    const fragment = defineFragment<{ apiKey: string }>("test")
      .withDependencies(({ config }) => ({
        client: { apiKey: config.apiKey },
      }))
      .providesService(({ deps, defineService }) =>
        defineService({
          getApiKey: () => deps.client.apiKey,
        }),
      );

    const testFragment = createFragmentForTest(fragment, [], {
      config: { apiKey: "test-key" },
      services: { getApiKey: () => "override-key" },
    });

    expect(testFragment.services.getApiKey()).toBe("override-key");
  });

  it("should initialize route factories with fragment context", async () => {
    type Config = { multiplier: number };
    type Deps = { dep: string };
    type Services = { multiply: (x: number) => number };

    const fragment = defineFragment<Config>("test")
      .withDependencies(() => ({ dep: "value" }))
      .providesService(({ config, defineService }) =>
        defineService({
          multiply: (x: number) => x * config.multiplier,
        }),
      );

    const routeFactory = defineRoutes<Config, Deps, Services>().create(({ services }) => [
      defineRoute({
        method: "GET",
        path: "/multiply/:num",
        outputSchema: z.object({ result: z.number() }),
        handler: async ({ pathParams }, { json }) => {
          const { num } = pathParams;
          return json({ result: services.multiply(Number(num)) });
        },
      }),
    ]);

    const routes = [routeFactory] as const;

    const testFragment = createFragmentForTest(fragment, routes, {
      config: { multiplier: 3 },
    });

    // Test that the route was initialized with the correct services
    const response = await testFragment.callRoute("GET", "/multiply/:num", {
      //       ^?
      pathParams: { num: "5" },
    });
    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data).toEqual({ result: 15 }); // 5 * 3
      expectTypeOf(response.data).toMatchObjectType<{ result: number }>();
    }
  });
});

describe("fragment.callRoute", () => {
  it("should handle JSON response", async () => {
    const fragment = defineFragment<{ apiKey: string }>("test");

    const route = defineRoute({
      method: "GET",
      path: "/test",
      outputSchema: z.object({ message: z.string() }),
      handler: async (_ctx, { json }) => {
        return json({ message: "hello" });
      },
    });

    const testFragment = createFragmentForTest(fragment, [route], {
      config: { apiKey: "test-key" },
    });

    const response = await testFragment.callRoute("GET", "/test");

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ message: "hello" });
      expect(response.headers).toBeInstanceOf(Headers);
      expectTypeOf(response.data).toMatchObjectType<{ message: string }>();
    }
  });

  it("should handle empty response", async () => {
    const fragment = defineFragment<{ apiKey: string }>("test");

    const route = defineRoute({
      method: "DELETE",
      path: "/test",
      handler: async (_ctx, { empty }) => {
        return empty(204);
      },
    });

    const testFragment = createFragmentForTest(fragment, [route], {
      config: { apiKey: "test-key" },
    });

    const response = await testFragment.callRoute("DELETE", "/test");

    expect(response.type).toBe("empty");
    if (response.type === "empty") {
      expect(response.status).toBe(204);
      expect(response.headers).toBeInstanceOf(Headers);
    }
  });

  it("should handle error response", async () => {
    const fragment = defineFragment<{ apiKey: string }>("test");

    const route = defineRoute({
      method: "GET",
      path: "/test",
      errorCodes: ["NOT_FOUND"] as const,
      handler: async (_ctx, { error }) => {
        return error({ message: "Not found", code: "NOT_FOUND" }, 404);
      },
    });

    const testFragment = createFragmentForTest(fragment, [route], {
      config: { apiKey: "test-key" },
    });

    const response = await testFragment.callRoute("GET", "/test");

    expect(response.type).toBe("error");
    if (response.type === "error") {
      expect(response.status).toBe(404);
      expect(response.error).toEqual({ message: "Not found", code: "NOT_FOUND" });
      expect(response.headers).toBeInstanceOf(Headers);
    }
  });

  it("should handle JSON stream response", async () => {
    const fragment = defineFragment<{ apiKey: string }>("test");

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

    const testFragment = createFragmentForTest(fragment, [route], {
      config: { apiKey: "test-key" },
    });

    const response = await testFragment.callRoute("GET", "/test/stream");

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
      expectTypeOf(items[0]).toMatchObjectType<{ value: number }>();
    }
  });

  it("should handle route factory created with defineRoutes", async () => {
    const fragment = defineFragment<{ apiKey: string }>("test").providesService(() => ({
      getGreeting: (name: string) => `Hello, ${name}!`,
      getCount: () => 42,
    }));

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

    const testFragment = createFragmentForTest(fragment, [routeFactory], {
      config: { apiKey: "test-key" },
    });

    // Test first route
    const greetingResponse = await testFragment.callRoute("GET", "/greeting/:name", {
      pathParams: { name: "World" },
    });

    console.log(greetingResponse);
    assert(greetingResponse.type === "json");
    expect(greetingResponse.data).toEqual({ message: "Hello, World!" });

    // Test second route
    const countResponse = await testFragment.callRoute("GET", "/count");

    expect(countResponse.type).toBe("json");
    if (countResponse.type === "json") {
      expect(countResponse.data).toEqual({ count: 42 });
    }
  });

  it("should handle path parameters", async () => {
    const fragment = defineFragment<{}>("test");

    const route = defineRoute({
      method: "GET",
      path: "/users/:id",
      outputSchema: z.object({ userId: z.string() }),
      handler: async ({ pathParams }, { json }) => {
        return json({ userId: pathParams.id });
      },
    });

    const testFragment = createFragmentForTest(fragment, [route], {
      config: {},
    });

    const response = await testFragment.callRoute("GET", "/users/:id", {
      pathParams: { id: "123" },
    });

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data).toEqual({ userId: "123" });
    }
  });

  it("should handle query parameters", async () => {
    const fragment = defineFragment<{}>("test");

    const route = defineRoute({
      method: "GET",
      path: "/search",
      outputSchema: z.object({ query: z.string() }),
      handler: async ({ query }, { json }) => {
        return json({ query: query.get("q") || "" });
      },
    });

    const testFragment = createFragmentForTest(fragment, [route], {
      config: {},
    });

    const response = await testFragment.callRoute("GET", "/search", {
      query: { q: "test" },
    });

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data).toEqual({ query: "test" });
    }
  });

  it("should handle request body", async () => {
    const fragment = defineFragment<{}>("test");

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

    const testFragment = createFragmentForTest(fragment, [route], {
      config: {},
    });

    const response = await testFragment.callRoute("POST", "/users", {
      body: { name: "John", email: "john@example.com" },
    });

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data).toEqual({ id: 1, name: "John", email: "john@example.com" });
    }
  });

  it("should have the right types", () => {
    const fragment = defineFragment<{}>("test");

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

    const testFragment = createFragmentForTest(fragment, [route], {
      config: {},
    });

    // Check what type body is expected to have
    type InputOptions = Parameters<typeof testFragment.callRoute<"POST", "/users">>[2];
    type BodyType = NonNullable<NonNullable<InputOptions>["body"]>;

    expectTypeOf<BodyType>().toMatchObjectType<{ name: string; email: string }>();
  });

  it("should handle custom headers", async () => {
    const fragment = defineFragment<{}>("test");

    const route = defineRoute({
      method: "GET",
      path: "/test",
      outputSchema: z.object({ authHeader: z.string() }),
      handler: async ({ headers }, { json }) => {
        return json({ authHeader: headers.get("authorization") || "" });
      },
    });

    const testFragment = createFragmentForTest(fragment, [route], {
      config: {},
    });

    const response = await testFragment.callRoute("GET", "/test", {
      headers: { authorization: "Bearer token" },
    });

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data).toEqual({ authHeader: "Bearer token" });
    }
  });

  it("should properly type path params", async () => {
    const fragment = defineFragment<{}>("test");

    const route = defineRoute({
      method: "GET",
      path: "/orgs/:orgId/users/:userId",
      outputSchema: z.object({ orgId: z.string(), userId: z.string() }),
      handler: async ({ pathParams }, { json }) => {
        return json({ orgId: pathParams.orgId, userId: pathParams.userId });
      },
    });

    const testFragment = createFragmentForTest(fragment, [route], {
      config: {},
    });

    const response = await testFragment.callRoute("GET", "/orgs/:orgId/users/:userId", {
      pathParams: { orgId: "123", userId: "456" },
    });

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data).toEqual({ orgId: "123", userId: "456" });
    }
  });
});
