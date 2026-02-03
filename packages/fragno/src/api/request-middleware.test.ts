import { test, expect, describe, expectTypeOf } from "vitest";
import { defineFragment } from "./fragment-definition-builder";
import { instantiate } from "./fragment-instantiator";
import { defineRoute, defineRoutes } from "./route";
import { z } from "zod";
import { FragnoApiValidationError } from "./error";

describe("Request Middleware", () => {
  test("middleware can intercept and return early", async () => {
    const config = { apiKey: "test" };

    const fragment = defineFragment<typeof config>("test-lib")
      .providesBaseService(() => ({
        auth: { isAuthorized: (token?: string) => token === "valid-token" },
      }))
      .build();

    const routes = [
      defineRoute({
        method: "GET",
        path: "/protected",
        handler: async (_input, { json }) => {
          return json({ message: "You accessed protected resource" });
        },
      }),
    ] as const;

    const instance = instantiate(fragment)
      .withConfig(config)
      .withRoutes(routes)
      .withOptions({ mountRoute: "/api" })
      .build();

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
      message: "Unauthorized",
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

    const fragment = defineFragment<typeof config>("test-lib").build();

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

    const instance = instantiate(fragment)
      .withConfig(config)
      .withRoutes(routes)
      .withOptions({ mountRoute: "/api" })
      .build()
      .withMiddleware(async ({ ifMatchesRoute }) => {
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
      message: "Creating users has been disabled.",
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

    const fragment = defineFragment<typeof config>("test-lib").build();

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

    const instance = instantiate(fragment)
      .withConfig(config)
      .withRoutes(routes)
      .withOptions({
        mountRoute: "/api",
      })
      .build()
      .withMiddleware(async ({ ifMatchesRoute }) => {
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

    const fragment = defineFragment<typeof config>("test-lib").build();

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

    const instance = instantiate(fragment)
      .withConfig(config)
      .withRoutes(routes)
      .withOptions({
        mountRoute: "/api",
      })
      .build()
      .withMiddleware(async ({ ifMatchesRoute }) => {
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

  test("ifMatchesRoute - supports internal linked fragment routes", async () => {
    const config = {};

    const internalDef = defineFragment("internal").build();
    const internalRoutes = defineRoutes(internalDef).create(({ defineRoute }) => [
      defineRoute({
        method: "GET",
        path: "/status",
        handler: async (_input, { json }) => {
          return json({ ok: true });
        },
      }),
    ]);

    const definition = defineFragment<typeof config>("test-lib")
      .withLinkedFragment("_fragno_internal", ({ config, options }) => {
        return instantiate(internalDef)
          .withConfig(config)
          .withOptions(options)
          .withRoutes([internalRoutes])
          .build();
      })
      .build();

    const instance = instantiate(definition)
      .withConfig(config)
      .withOptions({
        mountRoute: "/api",
      })
      .build()
      .withMiddleware(async ({ ifMatchesRoute }) => {
        return await ifMatchesRoute("GET", "/_internal/status", async ({ path }, { json }) => {
          expectTypeOf(path).toEqualTypeOf<"/_internal/status">();
          return json({ ok: false }, 418);
        });
      });

    const req = new Request("http://localhost/api/_internal/status", {
      method: "GET",
    });

    const res = await instance.handler(req);
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ ok: false });
  });

  test("only one middleware is supported", async () => {
    const config = {};

    const fragment = defineFragment<typeof config>("test-lib").build();

    const routes = [
      defineRoute({
        method: "GET",
        path: "/test",
        handler: async (_input, output) => {
          return output.json({ message: "test" });
        },
      }),
    ] as const;

    const instance = instantiate(fragment)
      .withConfig(config)
      .withRoutes(routes)
      .withOptions({})
      .build();

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

    const fragment = defineFragment<typeof config>("test-lib").build();

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

    const instance = instantiate(fragment)
      .withConfig(config)
      .withRoutes(routes)
      .withOptions({
        mountRoute: "/api",
      })
      .build()
      .withMiddleware(async ({ ifMatchesRoute }) => {
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
    const fragment = defineFragment("test-lib").build();

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

    const instance = instantiate(fragment)
      .withConfig({})
      .withRoutes(routes)
      .withOptions({
        mountRoute: "/api",
      })
      .build()
      .withMiddleware(async ({ ifMatchesRoute }) => {
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

    const fragment = defineFragment<typeof config>("test-lib").build();

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

    const instance = instantiate(fragment)
      .withConfig(config)
      .withRoutes(routes)
      .withOptions({
        mountRoute: "/api",
      })
      .build()
      .withMiddleware(async ({ ifMatchesRoute }) => {
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
      message: "Request validation failed in middleware",
      code: "MIDDLEWARE_VALIDATION_ERROR",
    });
  });

  test("middleware calling input.valid() can ignore validation error", async () => {
    const config = {};

    const fragment = defineFragment<typeof config>("test-lib").build();

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

    const instance = instantiate(fragment)
      .withConfig(config)
      .withRoutes(routes)
      .withOptions({
        mountRoute: "/api",
      })
      .build()
      .withMiddleware(async ({ ifMatchesRoute }) => {
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

  test("middleware can modify query parameters", async () => {
    const fragment = defineFragment("test-lib").build();

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

    const instance = instantiate(fragment)
      .withConfig({})
      .withRoutes(routes)
      .withOptions({
        mountRoute: "/api",
      })
      .build()
      .withMiddleware(async ({ ifMatchesRoute }) => {
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

  test("middleware can modify request body", async () => {
    const fragment = defineFragment("test-lib").build();

    const routes = [
      defineRoute({
        method: "POST",
        path: "/users",
        inputSchema: z.object({ name: z.string(), role: z.string().optional() }),
        outputSchema: z.object({ name: z.string(), role: z.string() }),
        handler: async ({ input }, { json }) => {
          const body = await input.valid();
          return json({
            name: body.name,
            role: body.role ?? "user",
          });
        },
      }),
    ] as const;

    const instance = instantiate(fragment)
      .withConfig({})
      .withRoutes(routes)
      .withOptions({
        mountRoute: "/api",
      })
      .build()
      .withMiddleware(async ({ ifMatchesRoute, requestState }) => {
        // Middleware modifies the request body
        const result = await ifMatchesRoute("POST", "/users", async ({ input }) => {
          const body = await input.valid();
          // Modify the body by adding a role field
          requestState.setBody({
            ...body,
            role: "admin-from-middleware",
          });
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
      name: "John Doe",
      role: "admin-from-middleware",
    });
  });

  test("middleware can modify request headers", async () => {
    const fragment = defineFragment("test-lib").build();

    const routes = [
      defineRoute({
        method: "GET",
        path: "/data",
        outputSchema: z.object({ auth: z.string(), custom: z.string() }),
        handler: async ({ headers }, { json }) => {
          return json({
            auth: headers.get("Authorization") ?? "none",
            custom: headers.get("X-Custom-Header") ?? "none",
          });
        },
      }),
    ] as const;

    const instance = instantiate(fragment)
      .withConfig({})
      .withRoutes(routes)
      .withOptions({
        mountRoute: "/api",
      })
      .build()
      .withMiddleware(async ({ headers }) => {
        // Middleware modifies headers
        headers.set("Authorization", "Bearer middleware-token");
        headers.set("X-Custom-Header", "middleware-value");
        return undefined;
      });

    const req = new Request("http://localhost/api/data", {
      method: "GET",
    });

    const res = await instance.handler(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      auth: "Bearer middleware-token",
      custom: "middleware-value",
    });
  });

  test("ifMatchesRoute properly awaits async handlers", async () => {
    const fragment = defineFragment("test-lib").build();

    const routes = [
      defineRoute({
        method: "POST",
        path: "/users",
        inputSchema: z.object({ name: z.string() }),
        outputSchema: z.object({ id: z.number(), name: z.string(), verified: z.boolean() }),
        handler: async ({ input }, { json }) => {
          const body = await input.valid();
          return json({
            id: 1,
            name: body.name,
            verified: false,
          });
        },
      }),
    ] as const;

    let asyncOperationCompleted = false;

    const instance = instantiate(fragment)
      .withConfig({})
      .withRoutes(routes)
      .withOptions({
        mountRoute: "/api",
      })
      .build()
      .withMiddleware(async ({ ifMatchesRoute }) => {
        const result = await ifMatchesRoute("POST", "/users", async ({ input }) => {
          // Simulate async operation (e.g., database lookup)
          await new Promise((resolve) => setTimeout(resolve, 10));
          const body = await input.valid();

          // Verify the async operation completed
          asyncOperationCompleted = true;

          // Check if user exists
          if (body.name === "existing-user") {
            return new Response(
              JSON.stringify({
                message: "User already exists",
                code: "USER_EXISTS",
              }),
              { status: 409, headers: { "Content-Type": "application/json" } },
            );
          }

          return undefined;
        });

        return result;
      });

    // Test with existing user
    const existingUserReq = new Request("http://localhost/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "existing-user" }),
    });

    const existingUserRes = await instance.handler(existingUserReq);
    expect(asyncOperationCompleted).toBe(true);
    expect(existingUserRes.status).toBe(409);
    expect(await existingUserRes.json()).toEqual({
      message: "User already exists",
      code: "USER_EXISTS",
    });

    // Reset flag
    asyncOperationCompleted = false;

    // Test with new user
    const newUserReq = new Request("http://localhost/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "new-user" }),
    });

    const newUserRes = await instance.handler(newUserReq);
    expect(asyncOperationCompleted).toBe(true);
    expect(newUserRes.status).toBe(200);
    expect(await newUserRes.json()).toEqual({
      id: 1,
      name: "new-user",
      verified: false,
    });
  });

  test("ifMatchesRoute handles async errors properly", async () => {
    const fragment = defineFragment("test-lib").build();

    const routes = [
      defineRoute({
        method: "GET",
        path: "/data",
        outputSchema: z.object({ data: z.string() }),
        handler: async (_, { json }) => {
          return json({ data: "test" });
        },
      }),
    ] as const;

    const instance = instantiate(fragment)
      .withConfig({})
      .withRoutes(routes)
      .withOptions({
        mountRoute: "/api",
      })
      .build()
      .withMiddleware(async ({ ifMatchesRoute }) => {
        const result = await ifMatchesRoute("GET", "/data", async (_, { error }) => {
          // Simulate async operation that fails
          await new Promise((resolve) => setTimeout(resolve, 5));

          // Simulate an error condition (e.g., database unavailable)
          return error(
            {
              message: "Service temporarily unavailable",
              code: "SERVICE_UNAVAILABLE",
            },
            503,
          );
        });

        return result;
      });

    const req = new Request("http://localhost/api/data", {
      method: "GET",
    });

    const res = await instance.handler(req);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      message: "Service temporarily unavailable",
      code: "SERVICE_UNAVAILABLE",
    });
  });

  test("ifMatchesRoute with async body modification", async () => {
    const fragment = defineFragment("test-lib").build();

    const routes = [
      defineRoute({
        method: "POST",
        path: "/posts",
        inputSchema: z.object({ title: z.string(), content: z.string() }),
        outputSchema: z.object({
          title: z.string(),
          content: z.string(),
          slug: z.string(),
          createdAt: z.number(),
        }),
        handler: async ({ input }, { json }) => {
          const body = await input.valid();
          return json({
            title: body.title,
            content: body.content,
            slug: body.title.toLowerCase().replace(/\s+/g, "-"),
            createdAt: Date.now(),
          });
        },
      }),
    ] as const;

    const instance = instantiate(fragment)
      .withConfig({})
      .withRoutes(routes)
      .withOptions({
        mountRoute: "/api",
      })
      .build()
      .withMiddleware(async ({ ifMatchesRoute, requestState }) => {
        const result = await ifMatchesRoute("POST", "/posts", async ({ input }) => {
          // Simulate async operation to enrich the body (e.g., fetching user data)
          await new Promise((resolve) => setTimeout(resolve, 5));

          const body = await input.valid();

          // Enrich the body with additional data
          requestState.setBody({
            ...body,
            content: `${body.content}\n\n[Enhanced by middleware]`,
          });

          return undefined;
        });

        return result;
      });

    const req = new Request("http://localhost/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test Post",
        content: "Original content",
      }),
    });

    const res = await instance.handler(req);
    expect(res.status).toBe(200);

    const responseBody = await res.json();
    expect(responseBody).toMatchObject({
      title: "Test Post",
      content: "Original content\n\n[Enhanced by middleware]",
      slug: "test-post",
    });
    expect(responseBody.createdAt).toBeTypeOf("number");
  });

  test("multiple async operations in ifMatchesRoute complete in order", async () => {
    const fragment = defineFragment("test-lib").build();

    const routes = [
      defineRoute({
        method: "GET",
        path: "/status",
        outputSchema: z.object({ message: z.string() }),
        handler: async (_, { json }) => {
          return json({ message: "OK" });
        },
      }),
    ] as const;

    const executionOrder: string[] = [];

    const instance = instantiate(fragment)
      .withConfig({})
      .withRoutes(routes)
      .withOptions({
        mountRoute: "/api",
      })
      .build()
      .withMiddleware(async ({ ifMatchesRoute }) => {
        executionOrder.push("start");

        const result = await ifMatchesRoute("GET", "/status", async () => {
          executionOrder.push("before-first-async");
          await new Promise((resolve) => setTimeout(resolve, 5));
          executionOrder.push("after-first-async");

          await new Promise((resolve) => setTimeout(resolve, 5));
          executionOrder.push("after-second-async");

          return undefined;
        });

        executionOrder.push("end");

        return result;
      });

    const req = new Request("http://localhost/api/status", {
      method: "GET",
    });

    const res = await instance.handler(req);
    expect(res.status).toBe(200);
    expect(executionOrder).toEqual([
      "start",
      "before-first-async",
      "after-first-async",
      "after-second-async",
      "end",
    ]);
  });
});
