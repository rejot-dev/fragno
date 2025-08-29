import { test, expect, describe } from "vitest";
import { buildUrl, getCacheKey } from "./client";

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
    const result = getCacheKey("GET", "/users");
    expect(result).toEqual(["GET", "/users"]);
  });

  test("should include path parameters in order", () => {
    const result = getCacheKey("GET", "/users/:id/posts/:postId", {
      pathParams: { id: "123", postId: "456" },
    });
    expect(result).toEqual(["GET", "/users/:id/posts/:postId", "123", "456"]);
  });

  test("should include query parameters in alphabetical order", () => {
    const result = getCacheKey("GET", "/users", {
      queryParams: { sort: "name", order: "asc" },
    });
    expect(result).toEqual(["GET", "/users", "asc", "name"]);
  });

  test("should handle missing path parameters", () => {
    const result = getCacheKey("GET", "/users/:id/posts/:postId", {
      pathParams: { id: "123" },
    });
    expect(result).toEqual(["GET", "/users/:id/posts/:postId", "123", "<missing>"]);
  });

  test("should handle both path and query parameters", () => {
    const result = getCacheKey("GET", "/users/:id", {
      pathParams: { id: "123" },
      queryParams: { sort: "name" },
    });
    expect(result).toEqual(["GET", "/users/:id", "123", "name"]);
  });

  test("should handle empty params object", () => {
    const result = getCacheKey("GET", "/users", {});
    expect(result).toEqual(["/users"]);
  });

  test("should handle undefined params", () => {
    const result = getCacheKey("GET", "/users");
    expect(result).toEqual(["GET", "/users"]);
  });
});
