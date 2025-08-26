import { test, expect, describe } from "vitest";
import { getAllPathParameterNames, buildUrl, getCacheKey } from "./client";

describe("getAllPathParameterNames", () => {
  test("should extract single path parameter", () => {
    const result = getAllPathParameterNames("/users/:id");
    expect(result).toEqual(["id"]);
  });

  test("should extract multiple path parameters", () => {
    const result = getAllPathParameterNames("/users/:id/posts/:postId");
    expect(result).toEqual(["id", "postId"]);
  });

  test("should extract wildcard path parameters", () => {
    const result = getAllPathParameterNames("/files/**:filename");
    expect(result).toEqual(["filename"]);
  });

  test("should extract mixed path and wildcard parameters", () => {
    const result = getAllPathParameterNames("/users/:id/files/**:filename");
    expect(result).toEqual(["id", "filename"]);
  });

  test("should handle paths with no parameters", () => {
    const result = getAllPathParameterNames("/users");
    expect(result).toEqual([]);
  });

  test("should handle root path", () => {
    const result = getAllPathParameterNames("/");
    expect(result).toEqual([]);
  });

  test("should handle empty path", () => {
    const result = getAllPathParameterNames("");
    expect(result).toEqual([]);
  });

  test("should handle paths with query parameters", () => {
    const result = getAllPathParameterNames("/users/:id?sort=name");
    expect(result).toEqual(["id"]);
  });

  test("should handle complex nested paths", () => {
    const result = getAllPathParameterNames(
      "/api/v1/users/:userId/posts/:postId/comments/:commentId",
    );
    expect(result).toEqual(["userId", "postId", "commentId"]);
  });

  test("should handle paths with multiple wildcards", () => {
    const result = getAllPathParameterNames("/api/**:version/users/**:userId");
    expect(result).toEqual(["version", "userId"]);
  });

  test("should handle paths with underscores in parameter names", () => {
    const result = getAllPathParameterNames("/users/:user_id/posts/:post_id");
    expect(result).toEqual(["user_id", "post_id"]);
  });

  test("should handle paths with numbers in parameter names", () => {
    const result = getAllPathParameterNames("/api/v1/:version1/users/:user2");
    expect(result).toEqual(["version1", "user2"]);
  });

  test("should handle paths with mixed case parameter names", () => {
    const result = getAllPathParameterNames("/users/:userId/posts/:PostId");
    expect(result).toEqual(["userId", "PostId"]);
  });

  test("should handle paths with adjacent parameters", () => {
    const result = getAllPathParameterNames("/users/:id:name");
    expect(result).toEqual(["id", "name"]);
  });

  test("should handle paths with parameters at the end", () => {
    const result = getAllPathParameterNames("/users/:id/posts/:postId/");
    expect(result).toEqual(["id", "postId"]);
  });

  test("should handle paths with parameters at the beginning", () => {
    const result = getAllPathParameterNames("/:id/users/:name");
    expect(result).toEqual(["id", "name"]);
  });

  test("should handle paths with only wildcard parameters", () => {
    const result = getAllPathParameterNames("/**:path");
    expect(result).toEqual(["path"]);
  });

  test("should handle paths with only path parameters", () => {
    const result = getAllPathParameterNames("/:param1/:param2/:param3");
    expect(result).toEqual(["param1", "param2", "param3"]);
  });

  test("should handle paths with mixed parameter types in complex scenarios", () => {
    const result = getAllPathParameterNames("/api/:version/users/:userId/files/**:filePath");
    expect(result).toEqual(["version", "userId", "filePath"]);
  });
});

describe("buildUrl", () => {
  test("should build URL with no parameters", () => {
    const result = buildUrl(
      { baseUrl: "http://localhost:3000", mountRoute: "/api", path: "/users" },
      {},
    );
    expect(result).toBe("http://localhost:3000/api/users");
  });

  test("should build URL with path parameters", () => {
    const result = buildUrl(
      { baseUrl: "http://localhost:3000", mountRoute: "/api", path: "/users/:id" },
      { pathParams: { id: "123" } },
    );
    expect(result).toBe("http://localhost:3000/api/users/123");
  });

  test("should build URL with query parameters", () => {
    const result = buildUrl(
      { baseUrl: "http://localhost:3000", mountRoute: "/api", path: "/users" },
      { queryParams: { sort: "name", order: "asc" } },
    );
    expect(result).toBe("http://localhost:3000/api/users?sort=name&order=asc");
  });

  test("should build URL with both path and query parameters", () => {
    const result = buildUrl(
      { baseUrl: "http://localhost:3000", mountRoute: "/api", path: "/users/:id/posts" },
      { pathParams: { id: "123" }, queryParams: { limit: "10" } },
    );
    expect(result).toBe("http://localhost:3000/api/users/123/posts?limit=10");
  });

  test("should handle empty baseUrl", () => {
    const result = buildUrl({ baseUrl: "", mountRoute: "/api", path: "/users" }, {});
    expect(result).toBe("/api/users");
  });

  test("should handle empty mountRoute", () => {
    const result = buildUrl(
      { baseUrl: "http://localhost:3000", mountRoute: "", path: "/users" },
      {},
    );
    expect(result).toBe("http://localhost:3000/users");
  });

  test("should handle undefined baseUrl", () => {
    const result = buildUrl({ mountRoute: "/api", path: "/users" }, {});
    expect(result).toBe("/api/users");
  });
});

describe("getCacheKey", () => {
  test("should return path only when no parameters", () => {
    const result = getCacheKey("/users");
    expect(result).toEqual(["/users"]);
  });

  test("should include path parameters in order", () => {
    const result = getCacheKey("/users/:id/posts/:postId", {
      pathParams: { id: "123", postId: "456" },
    });
    expect(result).toEqual(["/users/:id/posts/:postId", "123", "456"]);
  });

  test("should include query parameters in alphabetical order", () => {
    const result = getCacheKey("/users", {
      queryParams: { sort: "name", order: "asc" },
    });
    expect(result).toEqual(["/users", "asc", "name"]);
  });

  test("should handle missing path parameters", () => {
    const result = getCacheKey("/users/:id/posts/:postId", {
      pathParams: { id: "123" },
    });
    expect(result).toEqual(["/users/:id/posts/:postId", "123", "<missing>"]);
  });

  test("should handle both path and query parameters", () => {
    const result = getCacheKey("/users/:id", {
      pathParams: { id: "123" },
      queryParams: { sort: "name" },
    });
    expect(result).toEqual(["/users/:id", "123", "name"]);
  });

  test("should handle empty params object", () => {
    const result = getCacheKey("/users", {});
    expect(result).toEqual(["/users"]);
  });

  test("should handle undefined params", () => {
    const result = getCacheKey("/users");
    expect(result).toEqual(["/users"]);
  });
});
