import { test, expect, expectTypeOf, describe } from "vitest";
import { defineRoute } from "./route";
import { z } from "zod";

describe("defineRoute", () => {
  test("defineRoute no inputSchema", () => {
    const route = defineRoute({
      method: "GET",
      path: "/thing/**:path",
      handler: async ({ path, pathParams }, { empty }) => {
        expect(path).toEqual("/thing/**:path");
        expectTypeOf<typeof path>().toEqualTypeOf<"/thing/**:path">();

        expect(pathParams).toEqual({ path: "test" });
        expectTypeOf<typeof pathParams>().toEqualTypeOf<{ path: string }>();
        return empty();
      },
    });

    expect(route.method).toBe("GET");
    expect(route.path).toBe("/thing/**:path");
    expect(route.handler).toBeDefined();
  });

  test("defineRoute with inputSchema", () => {
    const route = defineRoute({
      method: "GET" as const,
      path: "/thing/**:path" as const,
      inputSchema: z.object({
        path: z.string(),
      }),
      handler: async ({ path, pathParams, input }, { empty }) => {
        expect(path).toEqual("/thing/**:path");
        expectTypeOf<typeof path>().toEqualTypeOf<"/thing/**:path">();

        expect(pathParams).toEqual({ path: "test" });
        expectTypeOf<typeof pathParams>().toEqualTypeOf<{ path: string }>();

        expect(input).toBeTruthy();
        if (input) {
          expectTypeOf<typeof input.schema>().toEqualTypeOf<z.ZodObject<{ path: z.ZodString }>>();
          expectTypeOf<typeof input.valid>().toEqualTypeOf<() => Promise<{ path: string }>>();

          const _valid = await input.valid();
          expectTypeOf<typeof _valid>().toEqualTypeOf<{ path: string }>();
        }
        return empty();
      },
    });

    expect(route.method).toBe("GET");
    expect(route.path).toBe("/thing/**:path");
    expect(route.inputSchema).toBeDefined();
    expect(route.handler).toBeDefined();
  });

  test("HTTPMethod DELETE without inputSchema or outputSchema", () => {
    const route = defineRoute({
      method: "DELETE",
      path: "/thing",
      handler: async ({ input }, { empty, json }) => {
        // FIXME: Would be nicer if input was not on the object at all
        expect(input).toBeUndefined();
        expectTypeOf<typeof input>().toEqualTypeOf<undefined>();

        // FIXME: Would be nicer if parameter of json was never, or not have json as field at all.
        expect(json).toBeDefined();
        expectTypeOf<Parameters<typeof json>[0]>().toEqualTypeOf<unknown>();

        return empty();
      },
    });

    expect(route.method).toBe("DELETE");
    expect(route.path).toBe("/thing");
    expect(route.handler).toBeDefined();
  });

  test("defineRoute with outputSchema", () => {
    const route = defineRoute({
      method: "GET",
      path: "/users",
      outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
      handler: async (_ctx, { json }) => {
        return json([{ id: 1, name: "John" }]);
      },
    });

    expect(route.method).toBe("GET");
    expect(route.path).toBe("/users");
    expect(route.outputSchema).toBeDefined();
    expect(route.handler).toBeDefined();
  });

  test("defineRoute with both inputSchema and outputSchema", () => {
    const route = defineRoute({
      method: "POST",
      path: "/users",
      inputSchema: z.object({ name: z.string(), email: z.string() }),
      outputSchema: z.object({ id: z.number(), name: z.string(), email: z.string() }),
      handler: async ({ input }, { json }) => {
        expect(input).toBeTruthy();
        if (input) {
          const data = await input.valid();
          return json({ id: 1, name: data.name, email: data.email });
        }
        return json({ id: 1, name: "", email: "" });
      },
    });

    expect(route.method).toBe("POST");
    expect(route.path).toBe("/users");
    expect(route.inputSchema).toBeDefined();
    expect(route.outputSchema).toBeDefined();
    expect(route.handler).toBeDefined();
  });

  test("defineRoute with path parameters", () => {
    const route = defineRoute({
      method: "GET",
      path: "/users/:id",
      outputSchema: z.object({ id: z.number(), name: z.string() }),
      handler: async ({ pathParams }, { json }) => {
        expectTypeOf<typeof pathParams>().toEqualTypeOf<{ id: string }>();
        return json({ id: Number(pathParams.id), name: "John" });
      },
    });

    expect(route.method).toBe("GET");
    expect(route.path).toBe("/users/:id");
    expect(route.outputSchema).toBeDefined();
    expect(route.handler).toBeDefined();
  });

  test("defineRoute with multiple path parameters", () => {
    const route = defineRoute({
      method: "GET",
      path: "/organizations/:orgId/users/:userId",
      outputSchema: z.object({ orgId: z.number(), userId: z.number() }),
      handler: async ({ pathParams }, { json }) => {
        expectTypeOf<typeof pathParams>().toEqualTypeOf<{ orgId: string; userId: string }>();
        return json({ orgId: Number(pathParams.orgId), userId: Number(pathParams.userId) });
      },
    });

    expect(route.method).toBe("GET");
    expect(route.path).toBe("/organizations/:orgId/users/:userId");
    expect(route.outputSchema).toBeDefined();
    expect(route.handler).toBeDefined();
  });

  test("defineRoute returns the same config object", () => {
    const config = {
      method: "GET" as const,
      path: "/test" as const,
      handler: async (_ctx: unknown, { empty }: { empty: () => Response }) => empty(),
    };

    const route = defineRoute(config);
    expect(route).toBe(config);
  });

  test("defineRoute with ValidPath type checking", () => {
    // Valid path
    const validRoute = defineRoute({
      method: "GET",
      path: "/api/users",
      handler: async (_ctx, { empty }) => empty(),
    });

    expectTypeOf(validRoute.path).toEqualTypeOf<"/api/users">();

    // TODO: Once ValidPath is integrated with defineRoute, add tests for invalid paths
    // Currently defineRoute doesn't enforce ValidPath constraints
  });
});
