import { test, expect, expectTypeOf } from "vitest";
import type { ExtractPathParams, ExtractPathParamNames, HasPathParams } from "./path-type";

// Type-only tests using expectTypeOf from vitest
test("ExtractPathParams type tests", () => {
  // Simple path without parameters
  expectTypeOf<ExtractPathParams<"/path">>().toEqualTypeOf<Record<string, never>>();

  // Single named parameter
  expectTypeOf<ExtractPathParams<"/path/:name">>().toEqualTypeOf<Record<"name", string>>();

  // Multiple named parameters
  expectTypeOf<ExtractPathParams<"/users/:id/posts/:postId">>().toEqualTypeOf<
    Record<"id" | "postId", string>
  >();

  // Wildcard without name
  expectTypeOf<ExtractPathParams<"/path/foo/**">>().toEqualTypeOf<Record<string, never>>();

  // Named wildcard
  expectTypeOf<ExtractPathParams<"/path/foo/**:name">>().toEqualTypeOf<Record<"name", string>>();

  // Complex path with mixed parameters
  expectTypeOf<
    ExtractPathParams<"/api/:version/users/:userId/posts/:postId/**:remaining">
  >().toEqualTypeOf<Record<"version" | "userId" | "postId" | "remaining", string>>();

  // Root path
  expectTypeOf<ExtractPathParams<"/">>().toEqualTypeOf<Record<string, never>>();

  // Empty string
  expectTypeOf<ExtractPathParams<"">>().toEqualTypeOf<Record<string, never>>();

  // Path with only parameter
  expectTypeOf<ExtractPathParams<":id">>().toEqualTypeOf<Record<"id", string>>();

  // Path with parameter at root
  expectTypeOf<ExtractPathParams<"/:id">>().toEqualTypeOf<Record<"id", string>>();
});

test("ExtractPathParamNames type tests", () => {
  // Simple path without parameters
  expectTypeOf<ExtractPathParamNames<"/path">>().toEqualTypeOf<never>();

  // Single named parameter
  expectTypeOf<ExtractPathParamNames<"/path/:name">>().toEqualTypeOf<"name">();

  // Multiple named parameters
  expectTypeOf<ExtractPathParamNames<"/users/:id/posts/:postId">>().toEqualTypeOf<
    "id" | "postId"
  >();

  // Wildcard without name
  expectTypeOf<ExtractPathParamNames<"/path/foo/**">>().toEqualTypeOf<never>();

  // Named wildcard
  expectTypeOf<ExtractPathParamNames<"/path/foo/**:name">>().toEqualTypeOf<"name">();

  // Complex path
  expectTypeOf<ExtractPathParamNames<"/api/:version/users/:userId/**:files">>().toEqualTypeOf<
    "version" | "userId" | "files"
  >();

  // Root and empty
  expectTypeOf<ExtractPathParamNames<"/">>().toEqualTypeOf<never>();
  expectTypeOf<ExtractPathParamNames<"">>().toEqualTypeOf<never>();
});

test("HasPathParams type tests", () => {
  // Paths without parameters
  expectTypeOf<HasPathParams<"/path">>().toEqualTypeOf<false>();
  expectTypeOf<HasPathParams<"/path/foo/bar">>().toEqualTypeOf<false>();
  expectTypeOf<HasPathParams<"/path/foo/**">>().toEqualTypeOf<false>();
  expectTypeOf<HasPathParams<"/">>().toEqualTypeOf<false>();
  expectTypeOf<HasPathParams<"">>().toEqualTypeOf<false>();

  // Paths with parameters
  expectTypeOf<HasPathParams<"/path/:name">>().toEqualTypeOf<true>();
  expectTypeOf<HasPathParams<"/users/:id">>().toEqualTypeOf<true>();
  expectTypeOf<HasPathParams<"/users/:id/posts/:postId">>().toEqualTypeOf<true>();
  expectTypeOf<HasPathParams<"/path/foo/**:name">>().toEqualTypeOf<true>();
  expectTypeOf<HasPathParams<":id">>().toEqualTypeOf<true>();
  expectTypeOf<HasPathParams<"/:id">>().toEqualTypeOf<true>();
});

// Edge case tests
test("ExtractPathParams edge cases", () => {
  // Parameter names with special characters (though not recommended in practice)
  expectTypeOf<ExtractPathParams<"/path/:user_id">>().toEqualTypeOf<Record<"user_id", string>>();
  expectTypeOf<ExtractPathParams<"/path/:user-id">>().toEqualTypeOf<Record<"user-id", string>>();

  // Consecutive slashes (malformed but should handle gracefully)
  expectTypeOf<ExtractPathParams<"//path//:name">>().toEqualTypeOf<Record<"name", string>>();

  // Mixed wildcards and parameters
  expectTypeOf<ExtractPathParams<"/api/:version/**:rest">>().toEqualTypeOf<
    Record<"version" | "rest", string>
  >();

  // Multiple wildcards (edge case)
  expectTypeOf<ExtractPathParams<"/api/**:first/**:second">>().toEqualTypeOf<
    Record<"first" | "second", string>
  >();
});

test("Real-world route examples", () => {
  // Common REST API patterns
  expectTypeOf<ExtractPathParams<"/api/v1/users/:userId">>().toEqualTypeOf<
    Record<"userId", string>
  >();
  expectTypeOf<
    ExtractPathParams<"/api/v1/users/:userId/posts/:postId/comments/:commentId">
  >().toEqualTypeOf<Record<"userId" | "postId" | "commentId", string>>();

  // File serving patterns
  expectTypeOf<ExtractPathParams<"/static/**:filepath">>().toEqualTypeOf<
    Record<"filepath", string>
  >();
  expectTypeOf<ExtractPathParams<"/uploads/:userId/**:filename">>().toEqualTypeOf<
    Record<"userId" | "filename", string>
  >();

  // Admin/dashboard patterns
  expectTypeOf<ExtractPathParams<"/admin/:section/:action">>().toEqualTypeOf<
    Record<"section" | "action", string>
  >();
  expectTypeOf<ExtractPathParams<"/dashboard/:org/projects/:projectId/settings">>().toEqualTypeOf<
    Record<"org" | "projectId", string>
  >();
});

// Runtime verification tests (ensuring the types work as expected in practice)
test("Type compatibility runtime tests", () => {
  // These tests verify that the types actually work as expected at runtime
  // by checking if type assignments would be valid

  // Function that expects no params
  function _handleNoParams(_params: ExtractPathParams<"/static/assets">) {
    // Should receive Record<string, never> which is essentially {}
  }

  // Function that expects specific params
  function _handleUserRoute(params: ExtractPathParams<"/users/:id">) {
    // Should have id property
    expect(typeof params).toBe("object");
    // Type system ensures params has 'id' property of type string
  }

  // Function that expects multiple params
  function _handleComplexRoute(
    params: ExtractPathParams<"/api/:version/users/:userId/posts/:postId">,
  ) {
    // Should have version, userId, and postId properties
    expect(typeof params).toBe("object");
    // Type system ensures all required properties exist
  }

  // Test type narrowing works
  const _path1 = "/users/:id" as const;
  type Path1Params = ExtractPathParams<typeof _path1>;
  expectTypeOf<Path1Params>().toEqualTypeOf<Record<"id", string>>();

  const _path2 = "/static/files" as const;
  type Path2Params = ExtractPathParams<typeof _path2>;
  expectTypeOf<Path2Params>().toEqualTypeOf<Record<string, never>>();

  // Verify HasPathParams utility
  const hasParams1: HasPathParams<"/users/:id"> = true;
  const hasParams2: HasPathParams<"/static"> = false;

  expect(hasParams1).toBe(true);
  expect(hasParams2).toBe(false);
});
