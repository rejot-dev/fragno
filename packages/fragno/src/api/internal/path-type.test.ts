import { test, expect, expectTypeOf } from "vitest";
import type {
  ExtractPathParams,
  ExtractPathParamNames,
  ExtractPathParamNamesAsTuple,
  ExtractPathParamsAsLabeledTuple,
  HasPathParams,
  ExtractPathParamsOrWiden,
  MaybeExtractPathParamsOrWiden,
} from "./path";
import type { StandardSchemaV1 } from "@standard-schema/spec";

// Type-only tests using expectTypeOf from vitest
test("ExtractPathParams type tests", () => {
  // Simple path without parameters
  expectTypeOf<ExtractPathParams<"/path">>().toEqualTypeOf<Record<string, never>>();

  // Single named parameter
  expectTypeOf<ExtractPathParams<"/path/:name">>().toEqualTypeOf<Record<"name", string>>();

  // Parameter with no name
  expectTypeOf<ExtractPathParams<"/path/:">>().toEqualTypeOf<Record<"", string>>();
  expectTypeOf<ExtractPathParams<"/path/:/x">>().toEqualTypeOf<Record<"", string>>();

  // Duplicate identifiers
  expectTypeOf<ExtractPathParams<"/path/:/x/:/">>().toEqualTypeOf<Record<"", string>>();
  expectTypeOf<ExtractPathParams<"/path/:var/x/:var">>().toEqualTypeOf<Record<"var", string>>();

  // Multiple named parameters
  expectTypeOf<ExtractPathParams<"/users/:id/posts/:postId">>().toEqualTypeOf<
    Record<"id" | "postId", string>
  >();

  // Wildcard without name
  expectTypeOf<ExtractPathParams<"/path/foo/**">>().toEqualTypeOf<Record<"**", string>>();

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

test("ExtractPathParams configurable value type tests", () => {
  // Test with number type
  expectTypeOf<ExtractPathParams<"/path", number>>().toEqualTypeOf<Record<string, never>>();
  expectTypeOf<ExtractPathParams<"/path/:id", number>>().toEqualTypeOf<Record<"id", number>>();
  expectTypeOf<ExtractPathParams<"/users/:id/posts/:postId", number>>().toEqualTypeOf<
    Record<"id" | "postId", number>
  >();

  // Test with boolean type
  expectTypeOf<ExtractPathParams<"/path/:enabled", boolean>>().toEqualTypeOf<
    Record<"enabled", boolean>
  >();
  expectTypeOf<ExtractPathParams<"/api/:debug/users/:active", boolean>>().toEqualTypeOf<
    Record<"debug" | "active", boolean>
  >();

  // Test with custom object type
  type CustomType = { value: string; parsed: boolean };
  expectTypeOf<ExtractPathParams<"/path/:data", CustomType>>().toEqualTypeOf<
    Record<"data", CustomType>
  >();
  expectTypeOf<ExtractPathParams<"/api/:config/**:metadata", CustomType>>().toEqualTypeOf<
    Record<"config" | "metadata", CustomType>
  >();

  // Test with union type
  type StringOrNumber = string | number;
  expectTypeOf<ExtractPathParams<"/path/:value", StringOrNumber>>().toEqualTypeOf<
    Record<"value", StringOrNumber>
  >();

  // Test with undefined (should work but not very useful)
  expectTypeOf<ExtractPathParams<"/path/:id", undefined>>().toEqualTypeOf<
    Record<"id", undefined>
  >();

  // Test backward compatibility - default should be string
  expectTypeOf<ExtractPathParams<"/path/:id">>().toEqualTypeOf<
    ExtractPathParams<"/path/:id", string>
  >();

  // Complex example with custom type
  type ParsedParam = { raw: string; validated: boolean; converted: number };
  expectTypeOf<
    ExtractPathParams<"/api/:version/users/:userId/posts/:postId", ParsedParam>
  >().toEqualTypeOf<Record<"version" | "userId" | "postId", ParsedParam>>();

  // Wildcard with custom type
  expectTypeOf<ExtractPathParams<"/files/**:path", File>>().toEqualTypeOf<Record<"path", File>>();

  // Mixed parameters and wildcards with custom type
  expectTypeOf<
    ExtractPathParams<"/api/:version/users/:userId/**:remaining", ParsedParam>
  >().toEqualTypeOf<Record<"version" | "userId" | "remaining", ParsedParam>>();

  // No parameters should still return Record<string, never> regardless of ValueType
  expectTypeOf<ExtractPathParams<"/static/assets", number>>().toEqualTypeOf<
    Record<string, never>
  >();
  expectTypeOf<ExtractPathParams<"/static/assets", CustomType>>().toEqualTypeOf<
    Record<string, never>
  >();
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
  expectTypeOf<ExtractPathParamNames<"/path/foo/**">>().toEqualTypeOf<"**">();

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

test("ExtractPathParamNamesAsTuple type tests", () => {
  // Simple path without parameters
  expectTypeOf<ExtractPathParamNamesAsTuple<"/path">>().toEqualTypeOf<[]>();

  // Single named parameter
  expectTypeOf<ExtractPathParamNamesAsTuple<"/path/:name">>().toEqualTypeOf<["name"]>();

  // Multiple named parameters (should preserve order)
  expectTypeOf<ExtractPathParamNamesAsTuple<"/users/:id/posts/:postId">>().toEqualTypeOf<
    ["id", "postId"]
  >();

  // Wildcard without name
  expectTypeOf<ExtractPathParamNamesAsTuple<"/path/foo/**">>().toEqualTypeOf<["**"]>();

  // Named wildcard
  expectTypeOf<ExtractPathParamNamesAsTuple<"/path/foo/**:name">>().toEqualTypeOf<["name"]>();

  // Complex path with mixed parameters (should preserve order)
  expectTypeOf<
    ExtractPathParamNamesAsTuple<"/api/:version/users/:userId/**:files">
  >().toEqualTypeOf<["version", "userId", "files"]>();

  // Root and empty
  expectTypeOf<ExtractPathParamNamesAsTuple<"/">>().toEqualTypeOf<[]>();
  expectTypeOf<ExtractPathParamNamesAsTuple<"">>().toEqualTypeOf<[]>();

  // Path with only parameter
  expectTypeOf<ExtractPathParamNamesAsTuple<":id">>().toEqualTypeOf<["id"]>();
  expectTypeOf<ExtractPathParamNamesAsTuple<"/:id">>().toEqualTypeOf<["id"]>();

  // More complex examples
  expectTypeOf<
    ExtractPathParamNamesAsTuple<"/api/:version/users/:userId/posts/:postId/**:remaining">
  >().toEqualTypeOf<["version", "userId", "postId", "remaining"]>();

  // Edge cases
  expectTypeOf<ExtractPathParamNamesAsTuple<"/path/:user_id">>().toEqualTypeOf<["user_id"]>();
  expectTypeOf<ExtractPathParamNamesAsTuple<"/path/:user-id">>().toEqualTypeOf<["user-id"]>();

  // Mixed wildcards and parameters
  expectTypeOf<ExtractPathParamNamesAsTuple<"/api/:version/**:rest">>().toEqualTypeOf<
    ["version", "rest"]
  >();
});

test("ExtractPathParamsAsLabeledTuple type tests", () => {
  // Simple path without parameters
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"/path">>().toEqualTypeOf<[]>();

  // Single named parameter
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"/path/:name">>().toEqualTypeOf<[name: string]>();

  // Multiple named parameters (should preserve order with labels)
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"/users/:id/posts/:postId">>().toEqualTypeOf<
    [id: string, postId: string]
  >();

  // Wildcard without name
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"/path/foo/**">>().toEqualTypeOf<[string]>();

  // Named wildcard
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"/path/foo/**:name">>().toEqualTypeOf<
    [name: string]
  >();

  // Complex path with mixed parameters (the example from the user)
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"/api/:version/**:rest">>().toEqualTypeOf<
    [version: string, rest: string]
  >();

  // More complex examples
  expectTypeOf<
    ExtractPathParamsAsLabeledTuple<"/api/:version/users/:userId/posts/:postId/**:remaining">
  >().toEqualTypeOf<[version: string, userId: string, postId: string, remaining: string]>();

  // Root and empty
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"/">>().toEqualTypeOf<[]>();
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"">>().toEqualTypeOf<[]>();

  // Path with only parameter
  expectTypeOf<ExtractPathParamsAsLabeledTuple<":id">>().toEqualTypeOf<[id: string]>();
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"/:id">>().toEqualTypeOf<[id: string]>();

  // Edge cases with special characters
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"/path/:user_id">>().toEqualTypeOf<
    [user_id: string]
  >();
  // "user-id" is not a valid identifier in the tuple, so it doesn't become labeled.
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"/path/:user-id">>().toEqualTypeOf<[string]>();

  // Real-world examples
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"/api/v1/users/:userId">>().toEqualTypeOf<
    [userId: string]
  >();
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"/uploads/:userId/**:filename">>().toEqualTypeOf<
    [userId: string, filename: string]
  >();
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"/admin/:section/:action">>().toEqualTypeOf<
    [section: string, action: string]
  >();
});

test("ExtractPathParamsAsLabeledTuple configurable element type tests", () => {
  // Test with number type
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"/path", number>>().toEqualTypeOf<[]>();
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"/path/:id", number>>().toEqualTypeOf<
    [id: number]
  >();
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"/users/:id/posts/:postId", number>>().toEqualTypeOf<
    [id: number, postId: number]
  >();

  // Test with boolean type
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"/path/:enabled", boolean>>().toEqualTypeOf<
    [enabled: boolean]
  >();
  expectTypeOf<
    ExtractPathParamsAsLabeledTuple<"/api/:debug/users/:active", boolean>
  >().toEqualTypeOf<[debug: boolean, active: boolean]>();

  // Test with custom object type
  type CustomType = { value: string; parsed: boolean };
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"/path/:data", CustomType>>().toEqualTypeOf<
    [data: CustomType]
  >();
  expectTypeOf<
    ExtractPathParamsAsLabeledTuple<"/api/:config/**:metadata", CustomType>
  >().toEqualTypeOf<[config: CustomType, metadata: CustomType]>();

  // Test with union type
  type StringOrNumber = string | number;
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"/path/:value", StringOrNumber>>().toEqualTypeOf<
    [value: StringOrNumber]
  >();

  // Test with undefined (should work but not very useful)
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"/path/:id", undefined>>().toEqualTypeOf<
    [id: undefined]
  >();

  // Test backward compatibility - default should be string
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"/path/:id">>().toEqualTypeOf<
    ExtractPathParamsAsLabeledTuple<"/path/:id", string>
  >();

  // Complex example with custom type
  type ParsedParam = { raw: string; validated: boolean; converted: number };
  expectTypeOf<
    ExtractPathParamsAsLabeledTuple<"/api/:version/users/:userId/posts/:postId", ParsedParam>
  >().toEqualTypeOf<[version: ParsedParam, userId: ParsedParam, postId: ParsedParam]>();

  // Wildcard with custom type
  expectTypeOf<ExtractPathParamsAsLabeledTuple<"/files/**:path", File>>().toEqualTypeOf<
    [path: File]
  >();
});

test("HasPathParams type tests", () => {
  // Paths without parameters
  expectTypeOf<HasPathParams<"/path">>().toEqualTypeOf<false>();
  expectTypeOf<HasPathParams<"/path/foo/bar">>().toEqualTypeOf<false>();
  expectTypeOf<HasPathParams<"/path/foo/**">>().toEqualTypeOf<true>();
  expectTypeOf<HasPathParams<"/">>().toEqualTypeOf<false>();
  expectTypeOf<HasPathParams<"">>().toEqualTypeOf<false>();

  // Paths with parameters
  expectTypeOf<HasPathParams<"/path/:name">>().toEqualTypeOf<true>();
  expectTypeOf<HasPathParams<"/users/:id">>().toEqualTypeOf<true>();
  expectTypeOf<HasPathParams<"/users/:id/posts/:postId">>().toEqualTypeOf<true>();
  expectTypeOf<HasPathParams<"/path/foo/**:name">>().toEqualTypeOf<true>();
  expectTypeOf<HasPathParams<":id">>().toEqualTypeOf<true>();
  expectTypeOf<HasPathParams<"/:id">>().toEqualTypeOf<true>();

  type _T = HasPathParams<string>;
  type _T2 = StandardSchemaV1.InferOutput<StandardSchemaV1>;
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

  expectTypeOf<ExtractPathParams<string>>().toEqualTypeOf<Record<string, never>>();
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

test("ExtractPathParamsOrWiden type tests", () => {
  expectTypeOf<ExtractPathParamsOrWiden<"/path">>().toEqualTypeOf<Record<string, never>>();
  expectTypeOf<ExtractPathParamsOrWiden<"/path/:id">>().toEqualTypeOf<Record<"id", string>>();
  expectTypeOf<ExtractPathParamsOrWiden<"/path/:id", number>>().toEqualTypeOf<
    Record<"id", number>
  >();
  expectTypeOf<ExtractPathParamsOrWiden<"/path/:id", boolean>>().toEqualTypeOf<
    Record<"id", boolean>
  >();
  expectTypeOf<ExtractPathParamsOrWiden<"/path/:id", undefined>>().toEqualTypeOf<
    Record<"id", undefined>
  >();

  // This is the actual tests
  expectTypeOf<ExtractPathParamsOrWiden<string>>().toEqualTypeOf<Record<string, string>>();
});

test("MaybeExtractPathParamsOrWiden type tests", () => {
  expectTypeOf<MaybeExtractPathParamsOrWiden<"/path">>().toEqualTypeOf<undefined>();
  expectTypeOf<MaybeExtractPathParamsOrWiden<"/path/:id">>().toEqualTypeOf<Record<"id", string>>();
  expectTypeOf<MaybeExtractPathParamsOrWiden<"/path/:id", number>>().toEqualTypeOf<
    Record<"id", number>
  >();
  expectTypeOf<MaybeExtractPathParamsOrWiden<string>>().toEqualTypeOf<undefined>();
});
