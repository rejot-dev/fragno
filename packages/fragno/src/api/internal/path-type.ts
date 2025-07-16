/**
 * Type helper to extract path parameters from a const string path
 *
 * Supports:
 * - Regular paths: "/path" -> never
 * - Named parameters: "/path/:name" -> "name"
 * - Wildcard paths: "/path/foo/**" -> never
 * - Named wildcard paths: "/path/foo/**:name" -> "name"
 */

// Helper type to split a string by '/'
type SplitPath<T extends string> = T extends `${infer First}/${infer Rest}`
  ? First extends ""
    ? SplitPath<Rest>
    : [First, ...SplitPath<Rest>]
  : T extends ""
    ? []
    : [T];

// Helper type to extract parameter name from a single segment
type ExtractParam<T extends string> = T extends `:${infer Name}`
  ? Name
  : T extends `**:${infer Name}`
    ? Name
    : never;

// Helper type to extract all parameter names from path segments
type ExtractParamsFromSegments<T extends readonly string[]> = T extends readonly [
  infer First,
  ...infer Rest,
]
  ? First extends string
    ? Rest extends readonly string[]
      ? ExtractParam<First> | ExtractParamsFromSegments<Rest>
      : ExtractParam<First>
    : never
  : never;

// Main type to extract path parameters from a path string
export type ExtractPathParams<T extends string> =
  ExtractParamsFromSegments<SplitPath<T>> extends never
    ? Record<string, never>
    : Record<ExtractParamsFromSegments<SplitPath<T>>, string>;

// Alternative version that returns the parameter names as a union type
export type ExtractPathParamNames<T extends string> = ExtractParamsFromSegments<SplitPath<T>>;

// Type to check if a path has parameters
export type HasPathParams<T extends string> = ExtractPathParamNames<T> extends never ? false : true;

// Example usage and type tests
// These demonstrate how the types work with the provided examples

// Test cases based on the examples:
// addRoute(router, "GET", "/path", { payload: "this path" });
type _Test1 = ExtractPathParams<"/path">; // Record<string, never>
type _Test1Names = ExtractPathParamNames<"/path">; // never
type _Test1HasParams = HasPathParams<"/path">; // false

// addRoute(router, "POST", "/path/:name", { payload: "named route" });
type _Test2 = ExtractPathParams<"/path/:name">; // Record<"name", string>
type _Test2Names = ExtractPathParamNames<"/path/:name">; // "name"
type _Test2HasParams = HasPathParams<"/path/:name">; // true

// addRoute(router, "GET", "/path/foo/**", { payload: "wildcard route" });
type _Test3 = ExtractPathParams<"/path/foo/**">; // Record<string, never>
type _Test3Names = ExtractPathParamNames<"/path/foo/**">; // never
type _Test3HasParams = HasPathParams<"/path/foo/**">; // false

// addRoute(router, "GET", "/path/foo/**:name", { payload: "named wildcard route" });
type _Test4 = ExtractPathParams<"/path/foo/**:name">; // Record<"name", string>
type _Test4Names = ExtractPathParamNames<"/path/foo/**:name">; // "name"
type _Test4HasParams = HasPathParams<"/path/foo/**:name">; // true

// Additional test cases
type _Test5 = ExtractPathParams<"/users/:id/posts/:postId">; // Record<"id" | "postId", string>
type _Test5Names = ExtractPathParamNames<"/users/:id/posts/:postId">; // "id" | "postId"
