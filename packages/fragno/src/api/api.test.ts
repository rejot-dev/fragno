import { test, expect, expectTypeOf, describe } from "vitest";
import { addRoute, type FragnoRouteConfig } from "./api";
import { createLibrary } from "../mod";
import { z } from "zod";

describe("addRoute", () => {
  test("addRoute no inputSchema", () => {
    addRoute({
      method: "GET" as const,
      path: "/thing/**:path" as const,
      handler: async ({ path, pathParams }, { empty }) => {
        expect(path).toEqual("/thing/**:path");
        expectTypeOf<typeof path>().toEqualTypeOf<"/thing/**:path">();

        expect(pathParams).toEqual({ path: "test" });
        expectTypeOf<typeof pathParams>().toEqualTypeOf<{ path: string }>();
        return empty();
      },
    });
  });

  test("addRoute with inputSchema", () => {
    addRoute({
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
  });

  test("Should have no type errors in createLibrary", () => {
    const config = {} as {
      readonly name: "test-library";
      readonly routes: readonly [Readonly<FragnoRouteConfig<"GET", "/", undefined, undefined>>];
    };

    expect(() => {
      createLibrary({}, config, {});
    }).toThrow();
  });
});
