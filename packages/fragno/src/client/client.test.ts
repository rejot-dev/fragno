import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { addRoute } from "../api/api";
import { buildUrl, clearHooksCache, createClientBuilder, getCacheKey } from "./client";
import { useFragno } from "./vanilla";
import { waitForAsyncIterator } from "../util/async";

// Mock fetch globally
global.fetch = vi.fn();

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
    expect(result).toEqual(["GET", "/users"]);
  });

  test("should handle undefined params", () => {
    const result = getCacheKey("GET", "/users");
    expect(result).toEqual(["GET", "/users"]);
  });
});

describe("invalidation", () => {
  const testLibraryConfig = {
    name: "test-library",
    routes: [
      addRoute({
        method: "GET",
        path: "/users",
        outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
        handler: async (_ctx, { json }) => json([{ id: 1, name: "John" }]),
      }),
      addRoute({
        method: "POST",
        path: "/users",
        inputSchema: z.object({ name: z.string() }),
        outputSchema: z.object({ id: z.number(), name: z.string() }),
        handler: async (_ctx, { json }) => json({ id: 2, name: "Jane" }),
      }),
      addRoute({
        method: "GET",
        path: "/users/:id",
        outputSchema: z.object({ id: z.number(), name: z.string() }),
        handler: async ({ pathParams }, { json }) =>
          json({ id: Number(pathParams["id"]), name: "John" }),
      }),
    ],
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    (global.fetch as ReturnType<typeof vi.fn>).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearHooksCache();
  });

  test("should automatically refetch when an item is invalidated", async () => {
    let callCount = 0;
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      return {
        headers: new Headers(),
        ok: true,
        json: async () => [{ id: callCount, name: `John${callCount}` }],
      };
    });

    const client = createClientBuilder({ baseUrl: "http://localhost:3000" }, testLibraryConfig);
    const clientObj = {
      useUsers: client.createHook("/users"),
      useMutateUsers: client.createMutator("POST", "/users"),
    };

    const { useUsers, useMutateUsers } = useFragno(clientObj);
    const userStore = useUsers();

    const stateAfterInitialLoad = await waitForAsyncIterator(
      userStore,
      (state) => state.loading === false,
    );
    expect(stateAfterInitialLoad).toEqual({
      loading: false,
      data: [{ id: 1, name: "John1" }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    // The second fetch call is the mutation.
    await useMutateUsers().mutate({
      body: { name: "John" },
      params: {},
    });

    const stateAfterRefetch = await waitForAsyncIterator(
      userStore,
      (state) => state.loading === false,
    );
    expect(stateAfterRefetch).toEqual({
      loading: false,
      data: [{ id: 3, name: "John3" }],
    });

    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test("should refetch when an item is invalidated", async () => {
    let callCount = 0;
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      return {
        headers: new Headers(),
        ok: true,
        json: async () => [{ id: callCount, name: `John${callCount}` }],
      };
    });

    const client = createClientBuilder({ baseUrl: "http://localhost:3000" }, testLibraryConfig);
    let invalidateCalled = false;
    const clientObj = {
      useUsers: client.createHook("/users"),
      modifyUsersManual: client.createMutator("POST", "/users", (invalidate) => {
        invalidateCalled = true;
        return invalidate("GET", "/users", {});
      }),
    };

    const { useUsers, modifyUsersManual } = useFragno(clientObj);
    const userStore = useUsers();

    const stateAfterInitialLoad = await waitForAsyncIterator(
      userStore,
      (state) => state.loading === false,
    );
    console.log(stateAfterInitialLoad.error);

    expect(stateAfterInitialLoad).toEqual({
      loading: false,
      data: [{ id: 1, name: "John1" }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    // The second fetch call is the mutation.
    await modifyUsersManual().mutate({
      body: { name: "John" },
      params: {},
    });
    expect(invalidateCalled).toBe(true);

    const stateAfterRefetch = await waitForAsyncIterator(
      userStore,
      (state) => state.loading === false,
    );
    expect(stateAfterRefetch).toEqual({
      loading: false,
      data: [{ id: 3, name: "John3" }],
    });

    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
