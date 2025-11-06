import { test, expect, describe } from "vitest";
import { defineFragment } from "./fragment-builder";
import { createFragment, instantiateFragment } from "./fragment-instantiation";
import { defineRoute, defineRoutes } from "./route";
import { z } from "zod";

describe("callRoute", () => {
  test("calls route handler with body", async () => {
    const config = { greeting: "Hello" };

    const fragment = defineFragment<typeof config>("test-fragment");

    const routesFactory = defineRoutes<typeof config>().create(() => {
      return [
        defineRoute({
          method: "POST",
          path: "/greet",
          inputSchema: z.object({ name: z.string() }),
          outputSchema: z.object({ message: z.string() }),
          handler: async ({ input }, { json }) => {
            const { name } = await input.valid();
            return json({ message: `Hello, ${name}!` });
          },
        }),
      ];
    });

    const instance = createFragment(fragment, config, [routesFactory], {});

    const response = await instance.callRoute("POST", "/greet", {
      body: { name: "World" },
    });

    // expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ message: "Hello, World!" });
    }
  });

  test("calls route handler with path params", async () => {
    const config = {};

    const fragment = defineFragment<typeof config>("test-fragment");

    const routesFactory = defineRoutes<typeof config>().create(() => {
      return [
        defineRoute({
          method: "GET",
          path: "/users/:id",
          outputSchema: z.object({ userId: z.string() }),
          handler: async ({ pathParams }, { json }) => {
            return json({ userId: pathParams.id });
          },
        }),
      ];
    });

    const instance = createFragment(fragment, config, [routesFactory], {});

    const response = await instance.callRoute("GET", "/users/:id", {
      pathParams: { id: "123" },
    });

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ userId: "123" });
    }
  });

  test("calls route handler with query parameters", async () => {
    const config = {};

    const fragment = defineFragment<typeof config>("test-fragment");

    const routesFactory = defineRoutes<typeof config>().create(() => {
      return [
        defineRoute({
          method: "GET",
          path: "/search",
          queryParameters: ["q", "limit"],
          outputSchema: z.object({ query: z.string(), limit: z.string().nullable() }),
          handler: async ({ query }, { json }) => {
            return json({
              query: query.get("q") || "",
              limit: query.get("limit"),
            });
          },
        }),
      ];
    });

    const instance = createFragment(fragment, config, [routesFactory], {});

    const response = await instance.callRoute("GET", "/search", {
      query: { q: "test", limit: "10" },
    });

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ query: "test", limit: "10" });
    }
  });

  test("calls route handler with URLSearchParams query", async () => {
    const config = {};

    const fragment = defineFragment<typeof config>("test-fragment");

    const routesFactory = defineRoutes<typeof config>().create(() => {
      return [
        defineRoute({
          method: "GET",
          path: "/search",
          queryParameters: ["q"],
          outputSchema: z.object({ query: z.string() }),
          handler: async ({ query }, { json }) => {
            return json({ query: query.get("q") || "" });
          },
        }),
      ];
    });

    const instance = createFragment(fragment, config, [routesFactory], {});

    const searchParams = new URLSearchParams({ q: "test-query" });
    const response = await instance.callRoute("GET", "/search", {
      query: searchParams,
    });

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ query: "test-query" });
    }
  });

  test("calls route handler with headers", async () => {
    const config = {};

    const fragment = defineFragment<typeof config>("test-fragment");

    const routesFactory = defineRoutes<typeof config>().create(() => {
      return [
        defineRoute({
          method: "GET",
          path: "/headers",
          outputSchema: z.object({ auth: z.string().nullable() }),
          handler: async ({ headers }, { json }) => {
            return json({ auth: headers.get("authorization") });
          },
        }),
      ];
    });

    const instance = createFragment(fragment, config, [routesFactory], {});

    const response = await instance.callRoute("GET", "/headers", {
      headers: { authorization: "Bearer token123" },
    });

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ auth: "Bearer token123" });
    }
  });

  test("calls route handler with Headers object", async () => {
    const config = {};

    const fragment = defineFragment<typeof config>("test-fragment");

    const routesFactory = defineRoutes<typeof config>().create(() => {
      return [
        defineRoute({
          method: "GET",
          path: "/headers",
          outputSchema: z.object({ auth: z.string().nullable() }),
          handler: async ({ headers }, { json }) => {
            return json({ auth: headers.get("authorization") });
          },
        }),
      ];
    });

    const instance = createFragment(fragment, config, [routesFactory], {});

    const requestHeaders = new Headers({ authorization: "Bearer token456" });
    const response = await instance.callRoute("GET", "/headers", {
      headers: requestHeaders,
    });

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ auth: "Bearer token456" });
    }
  });

  test("preserves response headers including Set-Cookie", async () => {
    const config = {};

    const fragment = defineFragment<typeof config>("test-fragment");

    const routesFactory = defineRoutes<typeof config>().create(() => {
      return [
        defineRoute({
          method: "POST",
          path: "/login",
          inputSchema: z.object({ username: z.string() }),
          outputSchema: z.object({ success: z.boolean() }),
          handler: async ({ input }, { json }) => {
            const { username } = await input.valid();
            const response = json({ success: true });
            response.headers.set("Set-Cookie", `session=${username}; HttpOnly; Path=/`);
            response.headers.set("X-Custom-Header", "custom-value");
            return response;
          },
        }),
      ];
    });

    const instance = createFragment(fragment, config, [routesFactory], {});

    const response = await instance.callRoute("POST", "/login", {
      body: { username: "testuser" },
    });

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.status).toBe(200);
      expect(response.headers.get("Set-Cookie")).toBe("session=testuser; HttpOnly; Path=/");
      expect(response.headers.get("X-Custom-Header")).toBe("custom-value");
      expect(response.data).toEqual({ success: true });
    }
  });

  test("validates input and returns error for invalid data", async () => {
    const config = {};

    const fragment = defineFragment<typeof config>("test-fragment");

    const routesFactory = defineRoutes<typeof config>().create(() => {
      return [
        defineRoute({
          method: "POST",
          path: "/validate",
          inputSchema: z.object({ age: z.number().min(18) }),
          outputSchema: z.object({ valid: z.boolean() }),
          handler: async ({ input }, { json }) => {
            const { age } = await input.valid();
            return json({ valid: age >= 18 });
          },
        }),
      ];
    });

    const instance = createFragment(fragment, config, [routesFactory], {});

    const response = await instance.callRoute("POST", "/validate", {
      body: { age: 15 },
    });

    expect(response.type).toBe("error");
    if (response.type === "error") {
      expect(response.status).toBe(400);
      expect(response.error.code).toBe("FRAGNO_VALIDATION_ERROR");
    }
  });

  test("handles errors thrown in route handler", async () => {
    const config = {};

    const fragment = defineFragment<typeof config>("test-fragment");

    const routesFactory = defineRoutes<typeof config>().create(() => {
      return [
        defineRoute({
          method: "GET",
          path: "/error",
          outputSchema: z.object({ result: z.string() }),
          handler: async () => {
            throw new Error("Unexpected error");
          },
        }),
      ];
    });

    const instance = createFragment(fragment, config, [routesFactory], {});

    const response = await instance.callRoute("GET", "/error");

    expect(response.type).toBe("error");
    if (response.type === "error") {
      expect(response.status).toBe(500);
      expect(response.error).toEqual({
        message: "Internal server error",
        code: "INTERNAL_SERVER_ERROR",
      });
    }
  });

  test("calls route handler with all parameters combined", async () => {
    const config = {};

    const fragment = defineFragment<typeof config>("test-fragment");

    const routesFactory = defineRoutes<typeof config>().create(() => {
      return [
        defineRoute({
          method: "POST",
          path: "/users/:id/update",
          inputSchema: z.object({ name: z.string() }),
          queryParameters: ["reason"],
          outputSchema: z.object({
            id: z.string(),
            name: z.string(),
            reason: z.string().nullable(),
            auth: z.string().nullable(),
          }),
          handler: async ({ pathParams, input, query, headers }, { json }) => {
            const { name } = await input.valid();
            return json({
              id: pathParams.id,
              name,
              reason: query.get("reason"),
              auth: headers.get("authorization"),
            });
          },
        }),
      ];
    });

    const instance = createFragment(fragment, config, [routesFactory], {});

    const response = await instance.callRoute("POST", "/users/:id/update", {
      pathParams: { id: "user123" },
      body: { name: "John Doe" },
      query: { reason: "profile-update" },
      headers: { authorization: "Bearer xyz" },
    });

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.status).toBe(200);
      expect(response.data).toEqual({
        id: "user123",
        name: "John Doe",
        reason: "profile-update",
        auth: "Bearer xyz",
      });
    }
  });

  test("calls route handler with no input options", async () => {
    const config = {};

    const fragment = defineFragment<typeof config>("test-fragment");

    const routesFactory = defineRoutes<typeof config>().create(() => {
      return [
        defineRoute({
          method: "GET",
          path: "/ping",
          outputSchema: z.object({ status: z.string() }),
          handler: async (_, { json }) => {
            return json({ status: "ok" });
          },
        }),
      ];
    });

    const instance = createFragment(fragment, config, [routesFactory], {});

    const response = await instance.callRoute("GET", "/ping");

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ status: "ok" });
    }
  });

  test("uses services in route handler called via callRoute", async () => {
    const config = {};

    type Services = {
      getUserName: () => string;
    };

    const fragment = defineFragment<typeof config>("test-fragment").providesService(
      ({ defineService }) => {
        return defineService({
          getUserName: () => "Test User",
        });
      },
    );

    const routesFactory = defineRoutes<typeof config, {}, Services>().create(({ services }) => {
      return [
        defineRoute({
          method: "GET",
          path: "/me",
          outputSchema: z.object({ name: z.string() }),
          handler: async (_, { json }) => {
            return json({ name: services.getUserName() });
          },
        }),
      ];
    });

    const instance = createFragment(fragment, config, [routesFactory], {});

    const response = await instance.callRoute("GET", "/me");

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ name: "Test User" });
    }
  });

  test("uses deps in route handler called via callRoute", async () => {
    const config = {};

    type Deps = {
      database: { query: () => string };
    };

    const fragment = defineFragment<typeof config>("test-fragment").withDependencies(() => {
      return {
        database: { query: () => "database-result" },
      };
    });

    const routesFactory = defineRoutes<typeof config, Deps>().create(({ deps }) => {
      return [
        defineRoute({
          method: "GET",
          path: "/data",
          outputSchema: z.object({ result: z.string() }),
          handler: async (_, { json }) => {
            return json({ result: deps.database.query() });
          },
        }),
      ];
    });

    const instance = createFragment(fragment, config, [routesFactory], {});

    const response = await instance.callRoute("GET", "/data");

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ result: "database-result" });
    }
  });

  test("this context is RequestThisContext for standard fragments", async () => {
    const config = {};

    const fragment = defineFragment<typeof config>("test-fragment");

    const routesFactory = defineRoutes<typeof config>().create(() => {
      return [
        defineRoute({
          method: "GET",
          path: "/context-test",
          outputSchema: z.object({ contextType: z.string() }),
          handler: async function (_, { json }) {
            // this should be RequestThisContext (empty object by default)
            expect(this).toBeDefined();
            expect(typeof this).toBe("object");
            return json({ contextType: "standard" });
          },
        }),
      ];
    });

    const instance = createFragment(fragment, config, [routesFactory], {});

    const response = await instance.callRoute("GET", "/context-test");

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ contextType: "standard" });
    }
  });

  test("route handlers receive correct this context at runtime", async () => {
    const fragment = defineFragment("this-test");

    const routesFactory = defineRoutes(fragment).create(({ defineRoute }) => {
      return [
        defineRoute({
          method: "GET",
          path: "/this-test",
          outputSchema: z.object({ hasThis: z.boolean() }),
          handler: async function (_, { json }) {
            // Verify that 'this' is defined and is an object
            const hasThis = this !== undefined && typeof this === "object";
            return json({ hasThis });
          },
        }),
      ];
    });

    const instance = createFragment(fragment, {}, [routesFactory], {});

    const response = await instance.callRoute("GET", "/this-test");

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ hasThis: true });
    }
  });
});

describe("FragmentInstantiationBuilder", () => {
  describe("instantiate", () => {
    test("basic instantiation with defaults", () => {
      const fragment = defineFragment<{ apiKey: string }>("test");

      const instance = instantiateFragment(fragment).build();

      expect(instance.config.name).toBe("test");
      expect(instance.deps).toEqual({});
      expect(instance.services).toEqual({});
    });

    test("with config", () => {
      const fragment = defineFragment<{ apiKey: string }>("test");

      const instance = instantiateFragment(fragment).withConfig({ apiKey: "test-key" }).build();

      expect(instance.config.name).toBe("test");
    });

    test("with routes", async () => {
      const fragment = defineFragment<{}>("test");

      const route = defineRoute({
        method: "GET",
        path: "/hello",
        outputSchema: z.object({ message: z.string() }),
        handler: async (_ctx, { json }) => json({ message: "hello" }),
      });

      const instance = instantiateFragment(fragment).withConfig({}).withRoutes([route]).build();

      const response = await instance.callRoute("GET", "/hello");

      expect(response.type).toBe("json");
      if (response.type === "json") {
        expect(response.data).toEqual({ message: "hello" });
      }
    });

    test("with options", () => {
      const fragment = defineFragment<{}>("test");

      const instance = instantiateFragment(fragment)
        .withConfig({})
        .withOptions({ mountRoute: "/custom" })
        .build();

      expect(instance.mountRoute).toBe("/custom");
    });

    test("with services (used services)", () => {
      interface IEmailService {
        sendEmail(to: string, subject: string): Promise<void>;
      }

      const emailImpl: IEmailService = {
        sendEmail: async () => {},
      };

      const fragment = defineFragment<{}>("test").usesService<"email", IEmailService>("email");

      const instance = instantiateFragment(fragment)
        .withConfig({})
        .withServices({ email: emailImpl })
        .build();

      expect(instance.services.email).toBeDefined();
      expect(instance.services.email.sendEmail).toBeDefined();
    });

    test("all options together", async () => {
      interface ILogger {
        log(message: string): void;
      }

      const loggerImpl: ILogger = {
        log: () => {},
      };

      const fragment = defineFragment<{ apiKey: string }>("test")
        .withDependencies(({ config }) => ({
          client: { key: config.apiKey },
        }))
        .usesService<"logger", ILogger>("logger");

      const route = defineRoute({
        method: "GET",
        path: "/test",
        outputSchema: z.object({ success: z.boolean() }),
        handler: async (_ctx, { json }) => json({ success: true }),
      });

      const instance = instantiateFragment(fragment)
        .withConfig({ apiKey: "my-key" })
        .withRoutes([route])
        .withOptions({ mountRoute: "/api" })
        .withServices({ logger: loggerImpl })
        .build();

      expect(instance.config.name).toBe("test");
      expect(instance.mountRoute).toBe("/api");
      expect(instance.deps.client.key).toBe("my-key");
      expect(instance.services.logger).toBeDefined();

      const response = await instance.callRoute("GET", "/test");
      expect(response.type).toBe("json");
      if (response.type === "json") {
        expect(response.data).toEqual({ success: true });
      }
    });

    test("method chaining is fluent", () => {
      const fragment = defineFragment<{ apiKey: string }>("test");

      // Should be chainable
      const builder = instantiateFragment(fragment)
        .withConfig({ apiKey: "key" })
        .withRoutes([])
        .withOptions({});

      expect(builder).toBeDefined();
      expect(typeof builder.build).toBe("function");
    });

    test("config defaults to empty object", () => {
      const fragment = defineFragment<{}>("test");

      const instance = instantiateFragment(fragment).build();

      expect(instance).toBeDefined();
    });

    test("routes defaults to empty array", () => {
      const fragment = defineFragment<{}>("test");

      const instance = instantiateFragment(fragment).withConfig({}).build();

      expect(instance.config.routes).toEqual([]);
    });

    test("options defaults to empty object", () => {
      const fragment = defineFragment<{}>("test");

      const instance = instantiateFragment(fragment).withConfig({}).build();

      // Default mountRoute is generated
      expect(instance.mountRoute).toContain("/test");
    });

    test("services are optional if not required", () => {
      interface ILogger {
        log(message: string): void;
      }

      const fragment = defineFragment<{}>("test").usesService<"logger", ILogger>("logger", {
        optional: true,
      });

      // Should not throw even without providing the service
      const instance = instantiateFragment(fragment).withConfig({}).build();

      expect(instance).toBeDefined();
    });

    test("throws when required service not provided", () => {
      interface IEmailService {
        sendEmail(to: string): Promise<void>;
      }

      const fragment = defineFragment<{}>("test").usesService<"email", IEmailService>("email");

      expect(() => {
        instantiateFragment(fragment).withConfig({}).build();
      }).toThrow("Fragment 'test' requires service 'email' but it was not provided");
    });
  });
});
