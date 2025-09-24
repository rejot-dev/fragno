import { test, expect, describe, expectTypeOf } from "vitest";
import { defineFragment, createFragment } from "./fragment";
import { defineRoute } from "./route";
import { z } from "zod";
import { FragnoApiValidationError } from "./error";

describe("Request Middleware", () => {
  test("middleware can intercept and return early", async () => {
    const config = { apiKey: "test" };

    const fragment = defineFragment<typeof config>("test-lib").withServices(() => ({
      auth: { isAuthorized: (token?: string) => token === "valid-token" },
    }));

    const routes = [
      defineRoute({
        method: "GET",
        path: "/protected",
        handler: async (_input, { json }) => {
          return json({ message: "You accessed protected resource" });
        },
      }),
    ] as const;

    const instance = createFragment(fragment, config, routes, {
      mountRoute: "/api",
    });

    // Add middleware that checks authorization
    const withAuth = instance.withMiddleware(async ({ queryParams }, { services, error }) => {
      const q = queryParams.get("q");

      if (services.auth.isAuthorized(q ?? undefined)) {
        return undefined;
      }

      return error({ message: "Unauthorized", code: "UNAUTHORIZED" }, 401);
    });

    // Test unauthorized request
    const unauthorizedReq = new Request("http://localhost/api/protected", {
      method: "GET",
    });
    const unauthorizedRes = await withAuth.handler(unauthorizedReq);
    expect(unauthorizedRes.status).toBe(401);
    const unauthorizedBody = await unauthorizedRes.json();
    expect(unauthorizedBody).toEqual({
      error: "Unauthorized",
      code: "UNAUTHORIZED",
    });

    // Test authorized request
    const authorizedReq = new Request("http://localhost/api/protected?q=valid-token", {
      method: "GET",
    });
    const authorizedRes = await withAuth.handler(authorizedReq);
    expect(authorizedRes.status).toBe(200);
    const authorizedBody = await authorizedRes.json();
    expect(authorizedBody).toEqual({
      message: "You accessed protected resource",
    });
  });

  test("ifMatchesRoute - middleware has access to matched route information", async () => {
    const config = {};

    const fragment = defineFragment<typeof config>("test-lib");

    const routes = [
      defineRoute({
        method: "GET",
        path: "/users",
        outputSchema: z.object({ id: z.number(), name: z.string() }),
        handler: async (_, { json }) =>
          json({
            id: 1,
            name: "John Doe",
          }),
      }),
      defineRoute({
        method: "POST",
        path: "/users/:id",
        inputSchema: z.object({ name: z.string() }),
        outputSchema: z.object({ id: z.number(), name: z.string() }),
        handler: async ({ input, pathParams }, { json }) => {
          const body = await input.valid();

          return json({
            id: +pathParams.id,
            name: body?.name,
          });
        },
      }),
    ] as const;

    const instance = createFragment(fragment, config, routes, {
      mountRoute: "/api",
    }).withMiddleware(async ({ ifMatchesRoute }) => {
      const result = await ifMatchesRoute(
        "POST",
        "/users/:id",
        async ({ path, pathParams, input }, { error }) => {
          expectTypeOf(path).toEqualTypeOf<"/users/:id">();
          expectTypeOf(pathParams).toEqualTypeOf<{ id: string }>();

          expectTypeOf(input.schema).toEqualTypeOf<z.ZodObject<{ name: z.ZodString }>>();

          return error(
            {
              message: "Creating users has been disabled.",
              code: "CREATE_USERS_DISABLED",
            },
            403,
          );
        },
      );

      if (result) {
        return result;
      }

      // This was a request to any other route
      return undefined;
    });

    // Request to POST, should be disabled.
    const req = new Request("http://localhost/api/users/123", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "John Doe" }),
    });

    const res = await instance.handler(req);
    expect(res.status).toBe(403);

    expect(await res.json()).toEqual({
      error: "Creating users has been disabled.",
      code: "CREATE_USERS_DISABLED",
    });

    // Request to GET, should be enabled.
    const getReq = new Request("http://localhost/api/users", {
      method: "GET",
    });
    const getRes = await instance.handler(getReq);
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({
      id: 1,
      name: "John Doe",
    });
  });

  test("ifMatchesRoute - not called for other routes", async () => {
    const config = {};

    const fragment = defineFragment<typeof config>("test-lib");

    const routes = [
      defineRoute({
        method: "GET",
        path: "/users",
        outputSchema: z.object({ id: z.number(), name: z.string() }),
        handler: async (_, { json }) =>
          json({
            id: 1,
            name: "John Doe",
          }),
      }),
      defineRoute({
        method: "POST",
        path: "/users/:id",
        inputSchema: z.object({ name: z.string() }),
        outputSchema: z.object({ id: z.number(), name: z.string() }),
        handler: async ({ input, pathParams }, { json }) => {
          const body = await input.valid();

          return json({
            id: +pathParams.id,
            name: body?.name,
          });
        },
      }),
    ] as const;

    let middlewareCalled = false;

    const instance = createFragment(fragment, config, routes, {
      mountRoute: "/api",
    }).withMiddleware(async ({ ifMatchesRoute }) => {
      return ifMatchesRoute("GET", "/users", () => {
        middlewareCalled = true;
      });
    });

    // Request to POST, should be disabled.
    const req = new Request("http://localhost/api/users/123", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "John Doe" }),
    });

    const res = await instance.handler(req);
    expect(res.status).toBe(200);

    expect(await res.json()).toEqual({
      id: 123,
      name: "John Doe",
    });

    expect(middlewareCalled).toBe(false);
  });

  test("ifMatchesRoute - can return undefined", async () => {
    const config = {};

    const fragment = defineFragment<typeof config>("test-lib");

    const routes = [
      defineRoute({
        method: "GET",
        path: "/users",
        outputSchema: z.object({ id: z.number(), name: z.string() }),
        handler: async (_, { json }) =>
          json({
            id: 1,
            name: "John Doe",
          }),
      }),
    ] as const;

    let middlewareCalled = false;

    const instance = createFragment(fragment, config, routes, {
      mountRoute: "/api",
    }).withMiddleware(async ({ ifMatchesRoute }) => {
      await ifMatchesRoute("GET", "/users", async ({ path, pathParams, input }) => {
        expectTypeOf(path).toEqualTypeOf<"/users">();
        expectTypeOf(pathParams).toEqualTypeOf<{ [x: string]: never }>();
        expectTypeOf(input).toEqualTypeOf<undefined>();

        middlewareCalled = true;

        return undefined;
      });

      return undefined;
    });

    const getReq = new Request("http://localhost/api/users", {
      method: "GET",
    });
    const getRes = await instance.handler(getReq);
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({
      id: 1,
      name: "John Doe",
    });
    expect(middlewareCalled).toBe(true);
  });

  test("only one middleware is supported", async () => {
    const config = {};

    const fragment = defineFragment<typeof config>("test-lib");

    const routes = [
      defineRoute({
        method: "GET",
        path: "/test",
        handler: async (_input, output) => {
          return output.json({ message: "test" });
        },
      }),
    ] as const;

    const instance = createFragment(fragment, config, routes);

    const withMiddleware = instance.withMiddleware(async () => {
      return undefined;
    });

    // Trying to add a third middleware should throw
    expect(() => {
      withMiddleware.withMiddleware(async () => {
        return undefined;
      });
    }).toThrow("Middleware already set");
  });

  test("middleware and handler can both consume request body without double consumption", async () => {
    const config = {};

    const fragment = defineFragment<typeof config>("test-lib");

    const routes = [
      defineRoute({
        method: "POST",
        path: "/users",
        inputSchema: z.object({ name: z.string() }),
        outputSchema: z.object({ id: z.number(), name: z.string() }),
        handler: async ({ input }, { json }) => {
          const body = await input.valid();
          return json({
            id: 1,
            name: body?.name,
          });
        },
      }),
    ] as const;

    const instance = createFragment(fragment, config, routes, {
      mountRoute: "/api",
    }).withMiddleware(async ({ ifMatchesRoute }) => {
      // Middleware consumes the request body
      const result = await ifMatchesRoute("POST", "/users", async ({ input }) => {
        const body = await input.valid();
        // Middleware can read the body
        expect(body).toEqual({ name: "John Doe" });
        return undefined; // Continue to handler
      });

      return result;
    });

    const req = new Request("http://localhost/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "John Doe" }),
    });

    const res = await instance.handler(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: 1,
      name: "John Doe",
    });
  });

  test("middleware can modify path parameters", async () => {
    const fragment = defineFragment("test-lib");

    const routes = [
      defineRoute({
        method: "GET",
        path: "/users/:id",
        outputSchema: z.object({ id: z.number(), name: z.string(), role: z.string() }),
        handler: async ({ pathParams, query }, { json }) => {
          return json({
            id: +pathParams.id,
            name: "John Doe",
            role: query.get("role") ?? "user",
          });
        },
      }),
    ] as const;

    const instance = createFragment(fragment, {}, routes, {
      mountRoute: "/api",
    }).withMiddleware(async ({ ifMatchesRoute }) => {
      // Middleware can read path and query parameters
      const result = await ifMatchesRoute("GET", "/users/:id", async ({ pathParams }) => {
        pathParams.id = "9999";
      });

      return result;
    });

    // Test with admin role
    const adminReq = new Request("http://localhost/api/users/123?role=admin", {
      method: "GET",
    });
    const adminRes = await instance.handler(adminReq);
    expect(adminRes.status).toBe(200);
    expect(await adminRes.json()).toEqual({
      id: 9999,
      name: "John Doe",
      role: "admin",
    });
  });

  test("middleware calling input.valid() can catch validation error", async () => {
    const config = {};

    const fragment = defineFragment<typeof config>("test-lib");

    const routes = [
      defineRoute({
        method: "POST",
        path: "/users",
        inputSchema: z.object({
          name: z.string().min(1, "Name is required"),
          email: z.string().email("Invalid email format"),
        }),
        outputSchema: z.object({ id: z.number(), name: z.string(), email: z.string() }),
        handler: async ({ input }, { json }) => {
          const body = await input.valid();
          return json({
            id: 1,
            name: body.name,
            email: body.email,
          });
        },
      }),
    ] as const;

    const instance = createFragment(fragment, config, routes, {
      mountRoute: "/api",
    }).withMiddleware(async ({ ifMatchesRoute }) => {
      // Middleware tries to validate the input
      const result = await ifMatchesRoute("POST", "/users", async ({ input }, { error }) => {
        try {
          await input.valid();
          return undefined; // Continue to handler if valid
        } catch (validationError) {
          expect(validationError).toBeInstanceOf(FragnoApiValidationError);

          return error(
            {
              message: "Request validation failed in middleware",
              code: "MIDDLEWARE_VALIDATION_ERROR",
            },
            400,
          );
        }
      });

      return result;
    });

    // Test with invalid request (missing required fields)
    const invalidReq = new Request("http://localhost/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }), // Invalid: empty name and missing email
    });

    const res = await instance.handler(invalidReq);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body).toEqual({
      error: "Request validation failed in middleware",
      code: "MIDDLEWARE_VALIDATION_ERROR",
    });
  });

  test("middleware calling input.valid() can ignore validation error", async () => {
    const config = {};

    const fragment = defineFragment<typeof config>("test-lib");

    const routes = [
      defineRoute({
        method: "POST",
        path: "/users",
        inputSchema: z.object({
          name: z.string().min(1, "Name is required"),
          email: z.email("Invalid email format"),
        }),
        outputSchema: z.object({ id: z.number(), name: z.string(), email: z.string() }),
        handler: async (_ctx, { error }) => {
          return error(
            {
              message: "Handler should not be called",
              code: "HANDLER_SHOULD_NOT_BE_CALLED",
            },
            400,
          );
        },
      }),
    ] as const;

    const instance = createFragment(fragment, config, routes, {
      mountRoute: "/api",
    }).withMiddleware(async ({ ifMatchesRoute }) => {
      // Middleware tries to validate the input
      const result = await ifMatchesRoute("POST", "/users", async ({ input }) => {
        await input.valid();
      });

      return result;
    });

    // Test with invalid request (missing required fields)
    const invalidReq = new Request("http://localhost/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }), // Invalid: empty name and missing email
    });

    const res = await instance.handler(invalidReq);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body).toEqual({
      message: "Validation failed",
      issues: expect.any(Array),
      code: "FRAGNO_VALIDATION_ERROR",
    });
  });

  // TODO: This is not currently supported
  test.todo("middleware can modify query parameters", async () => {
    const fragment = defineFragment("test-lib");

    const routes = [
      defineRoute({
        method: "GET",
        path: "/users/:id",
        outputSchema: z.object({ id: z.number(), name: z.string(), role: z.string() }),
        handler: async ({ pathParams, query }, { json }) => {
          return json({
            id: +pathParams.id,
            name: "John Doe",
            role: query.get("role") ?? "user",
          });
        },
      }),
    ] as const;

    const instance = createFragment(fragment, {}, routes, {
      mountRoute: "/api",
    }).withMiddleware(async ({ ifMatchesRoute }) => {
      // Middleware can read path and query parameters
      const result = await ifMatchesRoute("GET", "/users/:id", async ({ query }) => {
        query.set("role", "some-other-role-defined-in-middleware");
      });

      return result;
    });

    // Test with admin role
    const adminReq = new Request("http://localhost/api/users/123?role=admin", {
      method: "GET",
    });
    const adminRes = await instance.handler(adminReq);
    expect(adminRes.status).toBe(200);
    expect(await adminRes.json()).toEqual({
      id: 123,
      name: "John Doe",
      role: "some-other-role-defined-in-middleware",
    });
  });
});
