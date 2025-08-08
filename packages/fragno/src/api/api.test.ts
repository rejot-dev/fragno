import { test, expect, expectTypeOf, describe } from "vitest";
import { addRoute, type FragnoRouteConfig } from "./api";
import { createLibrary } from "../mod";
import { z } from "zod";

describe("addRoute", () => {
  test("addRoute no inputSchema", () => {
    addRoute({
      method: "GET" as const,
      path: "/thing/**:path" as const,
      handler: async ({ path, pathParams, input }) => {
        expect(path).toEqual("/thing/**:path");
        expectTypeOf<typeof path>().toEqualTypeOf<"/thing/**:path">();

        expect(pathParams).toEqual({ path: "test" });
        expectTypeOf<typeof pathParams>().toEqualTypeOf<{ path: string }>();

        expect(input).toBeFalsy();
        expectTypeOf<typeof input>().toEqualTypeOf<never>();
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
      handler: async ({ path, pathParams, input }) => {
        expect(path).toEqual("/thing/**:path");
        expectTypeOf<typeof path>().toEqualTypeOf<"/thing/**:path">();

        expect(pathParams).toEqual({ path: "test" });
        expectTypeOf<typeof pathParams>().toEqualTypeOf<{ path: string }>();

        expect(input).toBeTruthy();
        expectTypeOf<typeof input.schema>().toEqualTypeOf<z.ZodObject<{ path: z.ZodString }>>();
        expectTypeOf<typeof input.valid>().toEqualTypeOf<() => Promise<{ path: string }>>();

        const _valid = await input.valid();
        expectTypeOf<typeof _valid>().toEqualTypeOf<{ path: string }>();
      },
    });
  });

  test("Should have no type errors when the libraryConfig object is `as const satisfies AnyFragnoLibrarySharedConfig`", () => {
    const _libraryConfig = {
      name: "test-library",
      routes: [
        addRoute({
          method: "GET",
          path: "/thing/**:path",
          handler: async ({ path, pathParams, input }) => {
            expect(path).toEqual("/thing/**:path");
            expectTypeOf<typeof path>().toEqualTypeOf<"/thing/**:path">();

            expect(input).toBeFalsy();
            expectTypeOf<typeof input>().toEqualTypeOf<never>();

            expect(pathParams).toEqual({ path: "test" });
            expectTypeOf<typeof pathParams>().toEqualTypeOf<{ path: string }>();
          },
        }),
      ],
    } as const;
  });

  test("Should have no type errors in createLibrary", () => {
    const config = {} as {
      readonly name: "test-library";
      readonly routes: readonly [Readonly<FragnoRouteConfig<"GET", "/", undefined, undefined>>];
    };

    expect(() => {
      createLibrary({}, config);
    }).toThrow();
  });
});
