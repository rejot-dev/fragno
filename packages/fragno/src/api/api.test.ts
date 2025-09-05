import { test, expect, expectTypeOf, describe } from "vitest";
import { addRoute, type FragnoRouteConfig, type ValidPath } from "./api";
import { createLibrary } from "../mod";
import { z } from "zod";

describe("addRoute", () => {
  test("addRoute no inputSchema", () => {
    addRoute({
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

describe("ValidPath", () => {
  test("accepts valid paths", () => {
    // Valid paths that start with "/", are not just "/", and don't end with "/"
    expectTypeOf<ValidPath<"/api">>().toEqualTypeOf<"/api">();
    expectTypeOf<ValidPath<"/users">>().toEqualTypeOf<"/users">();
    expectTypeOf<ValidPath<"/api/users">>().toEqualTypeOf<"/api/users">();
    expectTypeOf<ValidPath<"/api/v1/users">>().toEqualTypeOf<"/api/v1/users">();
    expectTypeOf<ValidPath<"/thing/**:path">>().toEqualTypeOf<"/thing/**:path">();
    expectTypeOf<ValidPath<"/a">>().toEqualTypeOf<"/a">();
  });

  test("rejects paths that don't start with '/'", () => {
    // Paths that don't start with "/" should have error brand
    expectTypeOf<ValidPath<"api">>().toEqualTypeOf<"api" & [`Error: Path must start with '/'.`]>();
    expectTypeOf<ValidPath<"users">>().toEqualTypeOf<
      "users" & [`Error: Path must start with '/'.`]
    >();
    expectTypeOf<ValidPath<"api/users">>().toEqualTypeOf<
      "api/users" & [`Error: Path must start with '/'.`]
    >();
    expectTypeOf<ValidPath<"">>().toEqualTypeOf<"" & [`Error: Path must start with '/'.`]>();
  });

  test("rejects root path '/'", () => {
    // Root path "/" should have error brand
    expectTypeOf<ValidPath<"/">>().toEqualTypeOf<"/" & [`Error: Path cannot be just '/'.`]>();
  });

  test("rejects paths ending with '/'", () => {
    // This type should show the error in IDE hover
    type _InvalidPathExample = ValidPath<"/api/">;

    // Paths ending with "/" should have error brand
    expectTypeOf<ValidPath<"/api/">>().toEqualTypeOf<
      "/api/" & [`Error: Path cannot end with '/'.`]
    >();
    expectTypeOf<ValidPath<"/users/">>().toEqualTypeOf<
      "/users/" & [`Error: Path cannot end with '/'.`]
    >();
    expectTypeOf<ValidPath<"/api/users/">>().toEqualTypeOf<
      "/api/users/" & [`Error: Path cannot end with '/'.`]
    >();
    expectTypeOf<ValidPath<"/api/v1/users/">>().toEqualTypeOf<
      "/api/v1/users/" & [`Error: Path cannot end with '/'.`]
    >();
  });

  test("rejects empty string", () => {
    // Empty string should have error brand
    expectTypeOf<ValidPath<"">>().toEqualTypeOf<"" & [`Error: Path must start with '/'.`]>();
  });

  test("ValidPath is still assignable to string", () => {
    // Valid paths should still be assignable to string
    const validPath: ValidPath<"/api"> = "/api";
    const str: string = validPath; // This should work
    expect(str).toBe("/api");

    // Invalid paths are also assignable to string (but have error brand)
    // @ts-expect-error - This shows the error message to the user
    const invalidPath: ValidPath<"/api/"> = "/api/";
    const str2: string = invalidPath; // This should also work
    expect(str2).toBe("/api/");
  });

  test("addRoute", () => {
    addRoute({
      method: "GET",
      // @ts-expect-error - This shows the error message to the user
      path: "/",
      handler: async (_ctx, { empty }) => empty(),
    });
  });
});
