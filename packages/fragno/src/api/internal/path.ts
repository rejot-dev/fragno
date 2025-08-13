/**
 * Type helper to extract path parameters from a const string path
 *
 * Supports:
 * - Regular paths: "/path" -> never
 * - Named parameters: "/path/:name" -> "name"
 * - Wildcard paths: "/path/foo/**" -> "**"
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
    : T extends "**"
      ? "**"
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
export type ExtractPathParams<T extends string, ValueType = string> =
  ExtractParamsFromSegments<SplitPath<T>> extends never
    ? Record<string, never>
    : Record<ExtractParamsFromSegments<SplitPath<T>>, ValueType>;

export type ExtractPathParamsOrWiden<T extends string, ValueType = string> = string extends T
  ? Record<string, ValueType>
  : ExtractPathParams<T, ValueType>;

// Alternative version that returns the parameter names as a union type
export type ExtractPathParamNames<T extends string> = ExtractParamsFromSegments<SplitPath<T>>;

// Helper type to extract parameter names as an ordered tuple from path segments
type ExtractParamNamesAsTuple<T extends readonly string[]> = T extends readonly [
  infer First,
  ...infer Rest,
]
  ? First extends string
    ? Rest extends readonly string[]
      ? ExtractParam<First> extends never
        ? ExtractParamNamesAsTuple<Rest>
        : [ExtractParam<First>, ...ExtractParamNamesAsTuple<Rest>]
      : ExtractParam<First> extends never
        ? []
        : [ExtractParam<First>]
    : []
  : [];

// Type to convert ExtractPathParamNames result to a string tuple with the same number of elements
export type ExtractPathParamNamesAsTuple<T extends string> = ExtractParamNamesAsTuple<SplitPath<T>>;

// Helper type to create labeled tuple from parameter names
type CreateLabeledTuple<T extends readonly string[], ElementType = string> = T extends readonly [
  infer First,
  ...infer Rest,
]
  ? First extends string
    ? Rest extends readonly string[]
      ? [{ [K in First]: ElementType }[First], ...CreateLabeledTuple<Rest, ElementType>]
      : [{ [K in First]: ElementType }[First]]
    : []
  : [];

// Type to convert path parameters to a labeled tuple
export type ExtractPathParamsAsLabeledTuple<
  T extends string,
  ElementType = string,
> = CreateLabeledTuple<ExtractParamNamesAsTuple<SplitPath<T>>, ElementType>;

// Type to check if a path has parameters
export type HasPathParams<T extends string> = ExtractPathParamNames<T> extends never ? false : true;

// Runtime utilities

/**
 * Extract parameter names from a path pattern at runtime.
 * Examples:
 * - "/users/:id" => ["id"]
 * - "/files/**" => ["**"]
 * - "/files/**:rest" => ["rest"]
 */
export function extractPathParams<TPath extends string>(
  pathPattern: TPath,
): ExtractPathParamNames<TPath>[] {
  const segments = pathPattern.split("/").filter((s) => s.length > 0);
  const names: string[] = [];

  for (const segment of segments) {
    if (segment.startsWith(":")) {
      names.push(segment.slice(1));
      continue;
    }

    if (segment === "**") {
      names.push("**");
      continue;
    }

    if (segment.startsWith("**:")) {
      names.push(segment.slice(3));
      continue;
    }
  }

  return names as ExtractPathParamNames<TPath>[];
}

/**
 * Match an actual path against a path pattern and return extracted params.
 *
 * Notes and limitations:
 * - Named segment ":name" captures a single path segment.
 * - Wildcard "**" or "**:name" greedily captures the remainder of the path and
 *   should be placed at the end of the pattern.
 * - If the path does not match the pattern, an empty object is returned.
 */
export function matchPathParams<TPath extends string>(
  pathPattern: TPath,
  actualPath: string,
): ExtractPathParams<TPath> {
  const patternSegments = pathPattern.split("/").filter((s) => s.length > 0);
  const actualSegments = actualPath.split("/").filter((s) => s.length > 0);

  const params: Record<string, string> = {};

  let i = 0;
  let j = 0;

  while (i < patternSegments.length && j < actualSegments.length) {
    const patternSegment = patternSegments[i];
    const actualSegment = actualSegments[j];

    if (patternSegment.startsWith(":")) {
      const name = patternSegment.slice(1);
      params[name] = decodeURIComponent(actualSegment);
      i += 1;
      j += 1;
      continue;
    }

    if (patternSegment === "**") {
      const remainder = actualSegments.slice(j).join("/");
      params["**"] = remainder ? decodeURIComponent(remainder) : "";
      // Wildcard consumes the rest; pattern should end here
      i = patternSegments.length;
      j = actualSegments.length;
      break;
    }

    if (patternSegment.startsWith("**:")) {
      const name = patternSegment.slice(3);
      const remainder = actualSegments.slice(j).join("/");
      params[name] = remainder ? decodeURIComponent(remainder) : "";
      // Wildcard consumes the rest; pattern should end here
      i = patternSegments.length;
      j = actualSegments.length;
      break;
    }

    // Literal segment must match exactly
    if (patternSegment === actualSegment) {
      i += 1;
      j += 1;
      continue;
    }

    // Mismatch
    return {} as ExtractPathParams<TPath>;
  }

  // If there are remaining pattern segments
  while (i < patternSegments.length) {
    const remaining = patternSegments[i];
    if (remaining === "**") {
      params["**"] = "";
      i += 1;
      continue;
    }
    if (remaining.startsWith(":")) {
      const name = remaining.slice(1);
      params[name] = "";
      i += 1;
      continue;
    }
    if (remaining.startsWith("**:")) {
      const name = remaining.slice(3);
      params[name] = "";
      i += 1;
      continue;
    }
    // Non-parameter remaining segment without corresponding actual segment → mismatch
    return {} as ExtractPathParams<TPath>;
  }

  // If there are remaining actual segments without pattern to match → mismatch
  if (j < actualSegments.length) {
    return {} as ExtractPathParams<TPath>;
  }

  return params as ExtractPathParams<TPath>;
}

/**
 * Build a concrete path by replacing placeholders in a path pattern with values.
 *
 * Supports the same placeholder syntax as the matcher:
 * - Named parameter ":name" is URL-encoded as a single segment
 * - Anonymous wildcard "**" inserts the remainder as-is (slashes preserved)
 * - Named wildcard "**:name" inserts the remainder from the named key
 *
 * Examples:
 * - buildPath("/users/:id", { id: "123" }) => "/users/123"
 * - buildPath("/files/**", { "**": "a/b" }) => "/files/a/b"
 * - buildPath("/files/**:rest", { rest: "a/b" }) => "/files/a/b"
 */
export function buildPath<TPath extends string>(
  pathPattern: TPath,
  params: ExtractPathParams<TPath>,
): string {
  const patternSegments = pathPattern.split("/");

  const builtSegments: string[] = [];

  for (const segment of patternSegments) {
    if (segment.length === 0) {
      // Preserve leading/trailing/duplicate slashes
      builtSegments.push("");
      continue;
    }

    if (segment.startsWith(":")) {
      const name = segment.slice(1);
      const value = (params as Record<string, string | undefined>)[name];
      if (value === undefined) {
        throw new Error(`Missing value for path parameter :${name}`);
      }
      builtSegments.push(encodeURIComponent(value));
      continue;
    }

    if (segment === "**") {
      const value = (params as Record<string, string | undefined>)["**"];
      if (value === undefined) {
        throw new Error("Missing value for path wildcard **");
      }
      builtSegments.push(value);
      continue;
    }

    if (segment.startsWith("**:")) {
      const name = segment.slice(3);
      const value = (params as Record<string, string | undefined>)[name];
      if (value === undefined) {
        throw new Error(`Missing value for path wildcard **:${name}`);
      }
      builtSegments.push(value);
      continue;
    }

    // Literal segment
    builtSegments.push(segment);
  }

  // Join with '/'. Empty segments preserve leading/trailing slashes
  return builtSegments.join("/");
}
