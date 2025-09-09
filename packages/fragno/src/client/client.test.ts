import { afterEach, assert, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { addRoute } from "../api/api";
import { buildUrl, createClientBuilder, getCacheKey, isGetHook, isMutatorHook } from "./client";
import { useFragno } from "./vanilla";
import { createAsyncIteratorFromCallback, waitForAsyncIterator } from "../util/async";
import type { FragnoPublicClientConfig } from "../mod";
import { atom } from "nanostores";

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

    expect(stateAfterInitialLoad).toEqual({
      loading: false,
      data: [{ id: 1, name: "John1" }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    // The second fetch call is the mutation.
    await modifyUsersManual().mutate({
      body: { name: "John" },
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

describe("hook parameter reactivity", () => {
  const clientConfig: FragnoPublicClientConfig = {
    baseUrl: "http://localhost:3000",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (global.fetch as ReturnType<typeof vi.fn>).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("should react to path parameters", async () => {
    const testLibraryConfig = {
      name: "test-library",
      routes: [
        addRoute({
          method: "GET",
          path: "/users/:id",
          outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
          handler: async (_ctx, { json }) => json([{ id: 1, name: "John" }]),
        }),
      ],
    } as const;

    vi.mocked(global.fetch).mockImplementation(async (input) => {
      assert(typeof input === "string");

      // Regex to extract id value from a URL string, matching only on /users/:id
      const [, id] = String(input).match(/\/users\/([^/]+)/) ?? [];

      expect(id).toBeDefined();
      expect(+id).not.toBeNaN();

      return {
        headers: new Headers(),
        ok: true,
        json: async () => ({ id: Number(id), name: "John" }),
      } as Response;
    });

    const cb = createClientBuilder(clientConfig, testLibraryConfig);
    const useUsers = cb.createHook("/users/:id");

    const idAtom = atom("123");
    const store = useUsers.store({ path: { id: idAtom } });

    const itt = createAsyncIteratorFromCallback(store.listen);

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: true,
        promise: expect.any(Promise),
        data: undefined,
        error: undefined,
      });
    }

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: false,
        data: { id: 123, name: "John" },
      });
    }

    idAtom.set("456");

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: true,
        promise: expect.any(Promise),
        data: undefined,
        error: undefined,
      });
    }

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: false,
        data: { id: 456, name: "John" },
      });
    }
  });

  test("should react to query parameters", async () => {
    const testLibraryConfig = {
      name: "test-library",
      routes: [
        addRoute({
          method: "GET",
          path: "/users",
          outputSchema: z.array(z.object({ id: z.number(), name: z.string(), role: z.string() })),
          handler: async (_ctx, { json }) => json([{ id: 1, name: "John", role: "admin" }]),
        }),
      ],
    } as const;

    vi.mocked(global.fetch).mockImplementation(async (input) => {
      assert(typeof input === "string");

      const url = new URL(input);
      const role = url.searchParams.get("role");
      const limit = url.searchParams.get("limit");

      expect(role).toBeDefined();

      return {
        headers: new Headers(),
        ok: true,
        json: async () => [
          { id: 1, name: "John", role: role! },
          ...(limit === "2" ? [{ id: 2, name: "Jane", role: role! }] : []),
        ],
      } as Response;
    });

    const cb = createClientBuilder(clientConfig, testLibraryConfig);
    const useUsers = cb.createHook("/users");

    const roleAtom = atom("admin");
    const limitAtom = atom("1");
    const store = useUsers.store({ query: { role: roleAtom, limit: limitAtom } });

    const itt = createAsyncIteratorFromCallback(store.listen);

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: true,
        promise: expect.any(Promise),
        data: undefined,
        error: undefined,
      });
    }

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: false,
        data: [{ id: 1, name: "John", role: "admin" }],
      });
    }

    // Change role
    roleAtom.set("user");

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: true,
        promise: expect.any(Promise),
        data: undefined,
        error: undefined,
      });
    }

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: false,
        data: [{ id: 1, name: "John", role: "user" }],
      });
    }

    // Change limit
    limitAtom.set("2");

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: true,
        promise: expect.any(Promise),
        data: undefined,
        error: undefined,
      });
    }

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: false,
        data: [
          { id: 1, name: "John", role: "user" },
          { id: 2, name: "Jane", role: "user" },
        ],
      });
    }
  });

  test("should react to combined path and query parameters", async () => {
    const testLibraryConfig = {
      name: "test-library",
      routes: [
        addRoute({
          method: "GET",
          path: "/users/:id/posts",
          outputSchema: z.array(
            z.object({ id: z.number(), title: z.string(), userId: z.number() }),
          ),
          handler: async (_ctx, { json }) => json([{ id: 1, title: "Post", userId: 1 }]),
        }),
      ],
    } as const;

    vi.mocked(global.fetch).mockImplementation(async (input) => {
      assert(typeof input === "string");

      const url = new URL(input);
      const [, userId] = url.pathname.match(/\/users\/([^/]+)\/posts/) ?? [];
      const status = url.searchParams.get("status");
      const limit = url.searchParams.get("limit");

      expect(userId).toBeDefined();
      expect(status).toBeDefined();

      const numPosts = limit === "2" ? 2 : 1;
      const posts = Array.from({ length: numPosts }, (_, i) => ({
        id: i + 1,
        title: `${status} Post ${i + 1}`,
        userId: Number(userId),
      }));

      return {
        headers: new Headers(),
        ok: true,
        json: async () => posts,
      } as Response;
    });

    const cb = createClientBuilder(clientConfig, testLibraryConfig);
    const usePosts = cb.createHook("/users/:id/posts");

    const userIdAtom = atom("123");
    const statusAtom = atom("published");
    const store = usePosts.store({
      path: { id: userIdAtom },
      query: { status: statusAtom, limit: "1" },
    });

    const itt = createAsyncIteratorFromCallback(store.listen);

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: true,
        promise: expect.any(Promise),
        data: undefined,
        error: undefined,
      });
    }

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: false,
        data: [{ id: 1, title: "published Post 1", userId: 123 }],
      });
    }

    // Change path parameter
    userIdAtom.set("456");

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: true,
        promise: expect.any(Promise),
        data: undefined,
        error: undefined,
      });
    }

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: false,
        data: [{ id: 1, title: "published Post 1", userId: 456 }],
      });
    }

    // Change query parameter
    statusAtom.set("draft");

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: true,
        promise: expect.any(Promise),
        data: undefined,
        error: undefined,
      });
    }

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: false,
        data: [{ id: 1, title: "draft Post 1", userId: 456 }],
      });
    }
  });

  test("should handle mixed atoms and non-atoms in parameters", async () => {
    const testLibraryConfig = {
      name: "test-library",
      routes: [
        addRoute({
          method: "GET",
          path: "/users/:id/posts",
          outputSchema: z.array(
            z.object({ id: z.number(), title: z.string(), category: z.string() }),
          ),
          handler: async (_ctx, { json }) => json([{ id: 1, title: "Post", category: "tech" }]),
        }),
      ],
    } as const;

    let fetchCallCount = 0;
    vi.mocked(global.fetch).mockImplementation(async (input) => {
      fetchCallCount++;
      assert(typeof input === "string");

      const url = new URL(input);
      const [, userId] = url.pathname.match(/\/users\/([^/]+)\/posts/) ?? [];
      const category = url.searchParams.get("category");
      const sort = url.searchParams.get("sort");

      expect(userId).toBeDefined();
      expect(category).toBeDefined();
      expect(sort).toBe("desc");

      return {
        headers: new Headers(),
        ok: true,
        json: async () => [
          {
            id: fetchCallCount,
            title: `Post ${fetchCallCount}`,
            category: category!,
          },
        ],
      } as Response;
    });

    const cb = createClientBuilder(clientConfig, testLibraryConfig);
    const usePosts = cb.createHook("/users/:id/posts");

    const userIdAtom = atom("123");
    const categoryAtom = atom("tech");
    // sort is a non-atom (static value)
    const store = usePosts.store({
      path: { id: userIdAtom },
      query: { category: categoryAtom, sort: "desc" },
    });

    const itt = createAsyncIteratorFromCallback(store.listen);

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: true,
        promise: expect.any(Promise),
        data: undefined,
        error: undefined,
      });
    }

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: false,
        data: [{ id: 1, title: "Post 1", category: "tech" }],
      });
    }

    expect(fetchCallCount).toBe(1);

    // Change atom parameter - should trigger refetch
    categoryAtom.set("science");

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: true,
        promise: expect.any(Promise),
        data: undefined,
        error: undefined,
      });
    }

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: false,
        data: [{ id: 2, title: "Post 2", category: "science" }],
      });
    }

    expect(fetchCallCount).toBe(2);

    // Change path atom parameter - should trigger refetch
    userIdAtom.set("456");

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: true,
        promise: expect.any(Promise),
        data: undefined,
        error: undefined,
      });
    }

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: false,
        data: [{ id: 3, title: "Post 3", category: "science" }],
      });
    }

    expect(fetchCallCount).toBe(3);
  });

  test("should not refetch when non-atom parameters remain unchanged", async () => {
    const testLibraryConfig = {
      name: "test-library",
      routes: [
        addRoute({
          method: "GET",
          path: "/users/:id",
          outputSchema: z.object({ id: z.number(), name: z.string() }),
          handler: async (_ctx, { json }) => json({ id: 1, name: "John" }),
        }),
      ],
    } as const;

    let fetchCallCount = 0;
    vi.mocked(global.fetch).mockImplementation(async (input) => {
      fetchCallCount++;
      assert(typeof input === "string");

      const [, id] = String(input).match(/\/users\/([^/]+)/) ?? [];
      expect(id).toBeDefined();

      return {
        headers: new Headers(),
        ok: true,
        json: async () => ({ id: Number(id), name: `John${fetchCallCount}` }),
      } as Response;
    });

    const cb = createClientBuilder(clientConfig, testLibraryConfig);
    const useUser = cb.createHook("/users/:id");

    const reactiveIdAtom = atom("123");
    // Create store with mixed params: one atom, one static
    const store = useUser.store({ path: { id: reactiveIdAtom } });

    const itt = createAsyncIteratorFromCallback(store.listen);

    // Initial load
    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: true,
        promise: expect.any(Promise),
        data: undefined,
        error: undefined,
      });
    }

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: false,
        data: { id: 123, name: "John1" },
      });
    }

    expect(fetchCallCount).toBe(1);

    // Create a second store with the same static parameter values
    // This should not trigger additional fetches since the cache key is the same
    const store2 = useUser.store({ path: { id: "123" } });
    const itt2 = createAsyncIteratorFromCallback(store2.listen);

    // Should get cached result immediately
    {
      const { value } = await itt2.next();
      expect(value).toEqual({
        loading: false,
        data: { id: 123, name: "John1" },
      });
    }

    // No additional fetch should have occurred
    expect(fetchCallCount).toBe(1);

    // Now change the reactive atom - should trigger new fetch
    reactiveIdAtom.set("456");

    // Note: the behaviour in the next two steps is pretty weird, as first we keep the old data
    //       but then we go to loading anyway.
    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: false,
        data: { id: 123, name: "John1" },
      });
    }

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: true,
        promise: expect.any(Promise),
        data: undefined,
        error: undefined,
      });
    }

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: false,
        data: { id: 456, name: "John2" },
      });
    }

    expect(fetchCallCount).toBe(2);
  });

  test("should handle multiple reactive query parameters independently", async () => {
    const testLibraryConfig = {
      name: "test-library",
      routes: [
        addRoute({
          method: "GET",
          path: "/posts",
          outputSchema: z.array(
            z.object({
              id: z.number(),
              title: z.string(),
              category: z.string(),
              status: z.string(),
            }),
          ),
          queryParameters: ["category", "status", "author"],
          handler: async (_ctx, { json }) =>
            json([{ id: 1, title: "Post", category: "tech", status: "published" }]),
        }),
      ],
    } as const;

    let fetchCallCount = 0;
    vi.mocked(global.fetch).mockImplementation(async (input) => {
      fetchCallCount++;
      assert(typeof input === "string");

      const url = new URL(input);
      const category = url.searchParams.get("category") || "tech";
      const status = url.searchParams.get("status") || "published";
      const author = url.searchParams.get("author") || "john";

      return {
        headers: new Headers(),
        ok: true,
        json: async () => [
          {
            id: fetchCallCount,
            title: `${category} ${status} Post by ${author}`,
            category,
            status,
          },
        ],
      } as Response;
    });

    const cb = createClientBuilder(clientConfig, testLibraryConfig);
    const usePosts = cb.createHook("/posts");

    const categoryAtom = atom("tech");
    const statusAtom = atom("published");
    const authorAtom = atom("john");

    const store = usePosts.store({
      query: {
        category: categoryAtom,
        status: statusAtom,
        author: authorAtom,
      },
    });

    const itt = createAsyncIteratorFromCallback(store.listen);

    // Initial load
    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: true,
        promise: expect.any(Promise),
        data: undefined,
        error: undefined,
      });
    }

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: false,
        data: [
          { id: 1, title: "tech published Post by john", category: "tech", status: "published" },
        ],
      });
    }

    expect(fetchCallCount).toBe(1);

    // Change first atom
    categoryAtom.set("science");

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: true,
        promise: expect.any(Promise),
        data: undefined,
        error: undefined,
      });
    }

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: false,
        data: [
          {
            id: 2,
            title: "science published Post by john",
            category: "science",
            status: "published",
          },
        ],
      });
    }

    expect(fetchCallCount).toBe(2);

    // Change second atom
    statusAtom.set("draft");

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: true,
        promise: expect.any(Promise),
        data: undefined,
        error: undefined,
      });
    }

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: false,
        data: [
          { id: 3, title: "science draft Post by john", category: "science", status: "draft" },
        ],
      });
    }

    expect(fetchCallCount).toBe(3);

    // Change third atom
    authorAtom.set("jane");

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: true,
        promise: expect.any(Promise),
        data: undefined,
        error: undefined,
      });
    }

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: false,
        data: [
          { id: 4, title: "science draft Post by jane", category: "science", status: "draft" },
        ],
      });
    }

    expect(fetchCallCount).toBe(4);
  });
});

describe("createMutator", () => {
  const clientConfig: FragnoPublicClientConfig = {
    baseUrl: "http://localhost:3000",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (global.fetch as ReturnType<typeof vi.fn>).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("body is optional when no inputSchema in route", async () => {
    const testLibraryConfig = {
      name: "test-library",
      routes: [
        addRoute({
          method: "DELETE",
          path: "/users/:id",
          handler: async (_ctx, { empty }) => empty(),
        }),
      ],
    } as const;

    vi.mocked(global.fetch).mockImplementation(async () => {
      return new Response(null, { status: 201 });
    });

    const cb = createClientBuilder(clientConfig, testLibraryConfig);
    const deleteUser = cb.createMutator("DELETE", "/users/:id");

    const result = await deleteUser.mutateQuery({
      path: { id: "123" },
    });

    expect(result).toBeUndefined();
  });
});

describe("type guards", () => {
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
    ],
  } as const;

  test("isGetHook should correctly identify GET hooks using symbols", () => {
    const client = createClientBuilder({}, testLibraryConfig);
    const getHook = client.createHook("/users");
    const mutatorHook = client.createMutator("POST", "/users");

    expect(isGetHook(getHook)).toBe(true);
    // Test that it correctly identifies non-GET hooks
    expect(isGetHook(mutatorHook)).toBe(false);
  });

  test("isMutatorHook should correctly identify mutator hooks using symbols", () => {
    const client = createClientBuilder({}, testLibraryConfig);
    const getHook = client.createHook("/users");
    const mutatorHook = client.createMutator("POST", "/users");

    expect(isMutatorHook(mutatorHook)).toBe(true);
    // Test that it correctly identifies non-mutator hooks
    expect(isMutatorHook(getHook)).toBe(false);
  });

  test("type guards should work correctly with symbol checking", () => {
    const client = createClientBuilder({}, testLibraryConfig);
    const getHook = client.createHook("/users");
    const mutatorHook = client.createMutator("POST", "/users");

    // Test that the hooks have the expected methods/properties
    expect("store" in getHook).toBe(true);
    expect("query" in getHook).toBe(true);
    expect("mutateQuery" in mutatorHook).toBe(true);
    expect("mutatorStore" in mutatorHook).toBe(true);

    // The type guards should work based on symbols
    expect(isGetHook(getHook)).toBe(true);
    expect(isMutatorHook(mutatorHook)).toBe(true);
  });

  test("type guards should work correctly with object checking", () => {
    expect(isGetHook(1)).toBe(false);
    expect(isMutatorHook("absence of hook")).toBe(false);
    expect(isGetHook({})).toBe(false);
    expect(isMutatorHook({})).toBe(false);
    expect(isGetHook(null)).toBe(false);
    expect(isMutatorHook(null)).toBe(false);
    expect(isGetHook(undefined)).toBe(false);
    expect(isMutatorHook(undefined)).toBe(false);
    expect(isGetHook(true)).toBe(false);
    expect(isMutatorHook(true)).toBe(false);
    expect(isGetHook(false)).toBe(false);
    expect(isMutatorHook(false)).toBe(false);
    expect(isGetHook(Symbol("fragno-get-hook"))).toBe(false);
    expect(isMutatorHook(Symbol("fragno-mutator-hook"))).toBe(false);
    expect(isGetHook(Symbol("fragno-get-hook"))).toBe(false);
  });
});
