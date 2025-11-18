import { afterEach, assert, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { defineRoute } from "../api/route";
import { buildUrl, createClientBuilder, getCacheKey, isGetHook, isMutatorHook } from "./client";
import { useFragno } from "./vanilla";
import { createAsyncIteratorFromCallback, waitForAsyncIterator } from "../util/async";
import type { FragnoPublicClientConfig } from "./client";
import { atom, computed, effect } from "nanostores";
import { defineFragment } from "../api/fragment-definition-builder";
import { RequestOutputContext } from "../api/request-output-context";
import { FragnoClientUnknownApiError } from "./client-error";

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
  const testFragment = defineFragment("test-fragment").build();
  const testRoutes = [
    defineRoute({
      method: "GET",
      path: "/users",
      outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
      handler: async (_ctx, { json }) => json([{ id: 1, name: "John" }]),
    }),
    defineRoute({
      method: "POST",
      path: "/users",
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ id: z.number(), name: z.string() }),
      handler: async (_ctx, { json }) => json({ id: 2, name: "Jane" }),
    }),
    defineRoute({
      method: "GET",
      path: "/users/:id",
      outputSchema: z.object({ id: z.number(), name: z.string() }),
      handler: async ({ pathParams }, { json }) =>
        json({ id: Number(pathParams["id"]), name: "John" }),
    }),
  ] as const;

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

    const client = createClientBuilder(
      testFragment,
      { baseUrl: "http://localhost:3000" },
      testRoutes,
    );
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

    const client = createClientBuilder(
      testFragment,
      { baseUrl: "http://localhost:3000" },
      testRoutes,
    );
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
    const testFragment = defineFragment("test-fragment").build();
    const testRoutes = [
      defineRoute({
        method: "GET",
        path: "/users/:id",
        outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
        handler: async (_ctx, { json }) => json([{ id: 1, name: "John" }]),
      }),
    ] as const;

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

    const cb = createClientBuilder(testFragment, clientConfig, testRoutes);
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
    const testFragment = defineFragment("test-fragment").build();
    const testRoutes = [
      defineRoute({
        method: "GET",
        path: "/users",
        outputSchema: z.array(z.object({ id: z.number(), name: z.string(), role: z.string() })),
        handler: async (_ctx, { json }) => json([{ id: 1, name: "John", role: "admin" }]),
      }),
    ] as const;

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

    const cb = createClientBuilder(testFragment, clientConfig, testRoutes);
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

  test("should react to optional query parameters", async () => {
    const testFragment = defineFragment("test-fragment").build();
    const testRoutes = [
      defineRoute({
        method: "GET",
        path: "/users",
        queryParameters: ["thing"],
        outputSchema: z.array(z.object({ id: z.number(), name: z.string(), suffix: z.string() })),
        handler: async (_ctx, { json }) => json([{ id: 1, name: "John", suffix: "default" }]),
      }),
    ] as const;

    vi.mocked(global.fetch).mockImplementation(async (input) => {
      assert(typeof input === "string");

      const url = new URL(input);
      const thing = url.searchParams.get("thing");

      const suffix = thing ? `with-${thing}` : "without-thing";

      return {
        headers: new Headers(),
        ok: true,
        json: async () => [{ id: 1, name: "John", suffix }],
      } as Response;
    });

    const cb = createClientBuilder(testFragment, clientConfig, testRoutes);
    const useUsers = cb.createHook("/users");

    // This atom with string | undefined type should be accepted by the query parameter
    const thingAtom = atom<string | undefined>("initial");

    const store = useUsers.store({ query: { thing: thingAtom } });

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
        data: [{ id: 1, name: "John", suffix: "with-initial" }],
      });
    }

    // Change thing to another value
    thingAtom.set(undefined);

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
        data: [{ id: 1, name: "John", suffix: "without-thing" }],
      });
    }
  });

  test("should react to combined path and query parameters", async () => {
    const testFragment = defineFragment("test-fragment").build();
    const testRoutes = [
      defineRoute({
        method: "GET",
        path: "/users/:id/posts",
        outputSchema: z.array(z.object({ id: z.number(), title: z.string(), userId: z.number() })),
        handler: async (_ctx, { json }) => json([{ id: 1, title: "Post", userId: 1 }]),
      }),
    ] as const;

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

    const cb = createClientBuilder(testFragment, clientConfig, testRoutes);
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
    const testFragment = defineFragment("test-fragment").build();
    const testRoutes = [
      defineRoute({
        method: "GET",
        path: "/users/:id/posts",
        outputSchema: z.array(
          z.object({ id: z.number(), title: z.string(), category: z.string() }),
        ),
        handler: async (_ctx, { json }) => json([{ id: 1, title: "Post", category: "tech" }]),
      }),
    ] as const;

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

    const cb = createClientBuilder(testFragment, clientConfig, testRoutes);
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
    const testFragment = defineFragment("test-fragment").build();
    const testRoutes = [
      defineRoute({
        method: "GET",
        path: "/users/:id",
        outputSchema: z.object({ id: z.number(), name: z.string() }),
        handler: async (_ctx, { json }) => json({ id: 1, name: "John" }),
      }),
    ] as const;

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

    const cb = createClientBuilder(testFragment, clientConfig, testRoutes);
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
    const testFragment = defineFragment("test-fragment").build();
    const testRoutes = [
      defineRoute({
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
    ] as const;

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

    const cb = createClientBuilder(testFragment, clientConfig, testRoutes);
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

describe("createHook - streaming", () => {
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

  test("Should be able to stream data and receive updates in store (store.listen)", async () => {
    const streamFragmentDefinition = defineFragment("stream-fragment").build();
    const streamRoutes = [
      defineRoute({
        method: "GET",
        path: "/users-stream",
        outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
        handler: async () => {
          throw new Error("Not implemented");
        },
      }),
    ] as const;
    const client = createClientBuilder(streamFragmentDefinition, clientConfig, streamRoutes);
    const clientObj = {
      useUsersStream: client.createHook("/users-stream"),
    };

    vi.mocked(global.fetch).mockImplementation(async () => {
      const ctx = new RequestOutputContext(streamRoutes[0].outputSchema);
      return ctx.jsonStream(async (stream) => {
        await stream.write({ id: 1, name: "John" });
        await stream.sleep(1);
        await stream.write({ id: 2, name: "Jane" });
        await stream.sleep(1);
        await stream.write({ id: 3, name: "Jim" });
      });
    });

    const { useUsersStream } = clientObj;
    const userStore = useUsersStream.store({});

    const itt = createAsyncIteratorFromCallback(userStore.listen);

    {
      const { value } = await itt.next();
      assert(value);
      expect(value.loading).toBe(true);
      expect(value.data).toBeUndefined();
      expect(value.error).toBeUndefined();
    }

    {
      const { value } = await itt.next();
      assert(value);
      expect(value.loading).toBe(false);
      expect(value.data).toEqual([{ id: 1, name: "John" }]);
      expect(value.error).toBeUndefined();
    }

    {
      const { value } = await itt.next();
      assert(value);
      expect(value.loading).toBe(false);
      expect(value.data).toEqual([
        { id: 1, name: "John" },
        { id: 2, name: "Jane" },
      ]);
      expect(value.error).toBeUndefined();
    }

    {
      const { value } = await itt.next();
      assert(value);
      expect(value.loading).toBe(false);
      expect(value.data).toEqual([
        { id: 1, name: "John" },
        { id: 2, name: "Jane" },
        { id: 3, name: "Jim" },
      ]);
      expect(value.error).toBeUndefined();
    }
  });

  test("throws FragnoClientUnknownApiError when the stream is not valid JSON", async () => {
    const streamErrorFragmentDefinition = defineFragment("stream-error-fragment").build();
    const streamErrorRoutes = [
      defineRoute({
        method: "GET",
        path: "/users-stream-error",
        outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
        handler: async () => {
          throw new Error("Not implemented");
        },
      }),
    ] as const;

    vi.mocked(global.fetch).mockImplementation(async () => {
      const ctx = new RequestOutputContext(streamErrorRoutes[0].outputSchema);
      return ctx.jsonStream(async (stream) => {
        await stream.writeRaw("this is not json lol");
      });
    });

    const client = createClientBuilder(
      streamErrorFragmentDefinition,
      clientConfig,
      streamErrorRoutes,
    );
    const clientObj = {
      useUsersStreamError: client.createHook("/users-stream-error"),
    };

    const { useUsersStreamError } = clientObj;
    const userStore = useUsersStreamError.store({});

    const { error } = await waitForAsyncIterator(
      createAsyncIteratorFromCallback(userStore.listen),
      (value) => value.loading === false && value.error !== undefined,
    );

    expect(error).toBeInstanceOf(FragnoClientUnknownApiError);
  });

  test("throws FragnoClientUnknownApiError when the stream is new lines only", async () => {
    const streamErrorFragmentDefinition = defineFragment("stream-error-fragment").build();
    const streamErrorRoutes = [
      defineRoute({
        method: "GET",
        path: "/users-stream-error",
        outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
        handler: async () => {
          throw new Error("Not implemented");
        },
      }),
    ] as const;

    vi.mocked(global.fetch).mockImplementation(async () => {
      const ctx = new RequestOutputContext(streamErrorRoutes[0].outputSchema);
      return ctx.jsonStream(async (stream) => {
        await stream.writeRaw("\n\n");
      });
    });

    const client = createClientBuilder(
      streamErrorFragmentDefinition,
      clientConfig,
      streamErrorRoutes,
    );
    const clientObj = {
      useUsersStreamError: client.createHook("/users-stream-error"),
    };

    const { useUsersStreamError } = clientObj;
    const userStore = useUsersStreamError.store({});

    const { error } = await waitForAsyncIterator(
      createAsyncIteratorFromCallback(userStore.listen),
      (value) => value.loading === false && value.error !== undefined,
    );

    expect(error).toBeInstanceOf(FragnoClientUnknownApiError);
  });

  test("throws FragnoClientUnknownApiError with cause SyntaxError when the stream is not valid JSON (multiple empty lines)", async () => {
    const streamErrorFragmentDefinition = defineFragment("stream-error-fragment").build();
    const streamErrorRoutes = [
      defineRoute({
        method: "GET",
        path: "/users-stream-error",
        outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
        handler: async () => {
          throw new Error("Not implemented");
        },
      }),
    ] as const;

    vi.mocked(global.fetch).mockImplementation(async () => {
      const ctx = new RequestOutputContext(streamErrorRoutes[0].outputSchema);
      return ctx.jsonStream(async (stream) => {
        await stream.writeRaw("this is not json lol\n\n");
      });
    });

    const client = createClientBuilder(
      streamErrorFragmentDefinition,
      clientConfig,
      streamErrorRoutes,
    );
    const clientObj = {
      useUsersStreamError: client.createHook("/users-stream-error"),
    };

    const { useUsersStreamError } = clientObj;
    const userStore = useUsersStreamError.store({});

    const { error } = await waitForAsyncIterator(
      createAsyncIteratorFromCallback(userStore.listen),
      (value) => value.loading === false && value.error !== undefined,
    );

    expect(error).toBeInstanceOf(FragnoClientUnknownApiError);
    assert(error!.cause instanceof SyntaxError); // JSON parse failure gives a SyntaxError
    expect(error!.cause.message).toMatch(/Unexpected (token|identifier)/);
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
    const testFragment = defineFragment("test-fragment").build();
    const testRoutes = [
      defineRoute({
        method: "DELETE",
        path: "/users/:id",
        handler: async (_ctx, { empty }) => empty(),
      }),
    ] as const;

    vi.mocked(global.fetch).mockImplementation(async () => {
      return new Response(null, { status: 201 });
    });

    const cb = createClientBuilder(testFragment, clientConfig, testRoutes);
    const deleteUser = cb.createMutator("DELETE", "/users/:id");

    const result = await deleteUser.mutateQuery({
      path: { id: "123" },
    });

    expect(result).toBeUndefined();
  });
});

describe("createMutator - streaming", () => {
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

  test("should support streaming responses for mutations", async () => {
    const mutationStreamFragmentDefinition = defineFragment("mutation-stream-fragment").build();
    const mutationStreamRoutes = [
      defineRoute({
        method: "POST",
        path: "/process-items",
        inputSchema: z.object({ items: z.array(z.string()) }),
        outputSchema: z.array(z.object({ item: z.string(), status: z.string() })),
        handler: async ({ input }, { jsonStream }) => {
          const data = await input.valid();
          const { items } = data!;
          return jsonStream(async (stream) => {
            for (const item of items) {
              await stream.write({ item, status: "processed" });
              await stream.sleep(1);
            }
          });
        },
      }),
    ] as const;

    // Mock the fetch response for streaming with proper ReadableStream
    vi.mocked(global.fetch).mockImplementation(async () => {
      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        start(controller) {
          // Enqueue all chunks at once
          controller.enqueue(encoder.encode('{"item":"item1","status":"processed"}\n'));
          controller.enqueue(encoder.encode('{"item":"item2","status":"processed"}\n'));
          controller.enqueue(encoder.encode('{"item":"item3","status":"processed"}\n'));
          controller.close();
        },
      });

      // Create a proper Response object with the stream
      const response = new Response(stream, {
        status: 200,
        headers: new Headers({
          "transfer-encoding": "chunked",
          "content-type": "application/x-ndjson",
        }),
      });

      return response;
    });

    const client = createClientBuilder(
      mutationStreamFragmentDefinition,
      clientConfig,
      mutationStreamRoutes,
    );
    const mutator = client.createMutator("POST", "/process-items");

    const result = await mutator.mutateQuery({
      body: { items: ["item1", "item2", "item3"] },
    });

    // Streaming mutations return all items
    expect(result).toEqual([
      { item: "item1", status: "processed" },
      { item: "item2", status: "processed" },
      { item: "item3", status: "processed" },
    ]);
  });

  test("Should be able to mutate data and receive updates in store (store.subscribe)", async () => {
    const streamFragmentDefinition = defineFragment("stream-fragment").build();
    const streamRoutes = [
      defineRoute({
        method: "POST",
        path: "/users-stream",
        inputSchema: z.object({ items: z.array(z.string()) }),
        outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
        handler: async () => {
          throw new Error("Not implemented");
        },
      }),
    ] as const;
    const client = createClientBuilder(streamFragmentDefinition, clientConfig, streamRoutes);
    const useUsersMutateStream = client.createMutator("POST", "/users-stream");

    vi.mocked(global.fetch).mockImplementation(async () => {
      const ctx = new RequestOutputContext(streamRoutes[0].outputSchema);
      return ctx.jsonStream(async (stream) => {
        await stream.write({ id: 1, name: "John" });
        await stream.sleep(0);
        await stream.write({ id: 2, name: "Jane" });
        await stream.sleep(0);
        await stream.write({ id: 3, name: "Jim" });
      });
    });

    const { mutatorStore } = useUsersMutateStream;
    const itt = createAsyncIteratorFromCallback(mutatorStore.subscribe);

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: false,
        data: undefined,
        error: undefined,
        mutate: expect.any(Function),
      });
    }

    const firstItem = await mutatorStore.mutate({ body: { items: ["item1", "item2", "item3"] } });
    expect(firstItem).toEqual([{ id: 1, name: "John" }]);

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        loading: true,
        data: undefined,
        error: undefined,
        mutate: expect.any(Function),
      });
    }

    {
      const { value } = await itt.next();
      assert(value);
      expect(value).toEqual({
        loading: true,
        data: [{ id: 1, name: "John" }],
        error: undefined,
        mutate: expect.any(Function),
      });
    }

    {
      const { value } = await itt.next();
      assert(value);
      expect(value).toEqual({
        loading: false,
        data: [{ id: 1, name: "John" }],
        error: undefined,
        mutate: expect.any(Function),
      });
    }

    {
      const { value } = await itt.next();
      assert(value);
      expect(value).toEqual({
        loading: false,
        data: [
          { id: 1, name: "John" },
          { id: 2, name: "Jane" },
        ],
        error: undefined,
        mutate: expect.any(Function),
      });
    }

    {
      const { value } = await itt.next();
      assert(value);
      expect(value).toEqual({
        loading: false,
        data: [
          { id: 1, name: "John" },
          { id: 2, name: "Jane" },
          { id: 3, name: "Jim" },
        ],
        error: undefined,
        mutate: expect.any(Function),
      });
    }
  });

  test("Should be able to mutate data and receive updates in store (store.listen)", async () => {
    const streamFragmentDefinition = defineFragment("stream-fragment").build();
    const streamRoutes = [
      defineRoute({
        method: "POST",
        path: "/users-stream",
        inputSchema: z.object({ items: z.array(z.string()) }),
        outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
        handler: async () => {
          throw new Error("Not implemented");
        },
      }),
    ] as const;
    const client = createClientBuilder(streamFragmentDefinition, clientConfig, streamRoutes);
    const useUsersMutateStream = client.createMutator("POST", "/users-stream");

    vi.mocked(global.fetch).mockImplementation(async () => {
      const ctx = new RequestOutputContext(streamRoutes[0].outputSchema);
      return ctx.jsonStream(async (stream) => {
        await stream.write({ id: 1, name: "John" });
        await stream.sleep(0);
        await stream.write({ id: 2, name: "Jane" });
        await stream.sleep(0);
        await stream.write({ id: 3, name: "Jim" });
      });
    });

    const { mutatorStore } = useUsersMutateStream;
    const itt = createAsyncIteratorFromCallback(mutatorStore.listen);

    const firstItem = await mutatorStore.mutate({ body: { items: ["item1", "item2", "item3"] } });
    expect(firstItem).toEqual([{ id: 1, name: "John" }]);

    {
      const { value } = await itt.next();
      assert(value);
      expect(value).toEqual({
        loading: true,
        data: undefined,
        error: undefined,
        mutate: expect.any(Function),
      });
    }

    {
      const { value } = await itt.next();
      assert(value);
      expect(value).toEqual({
        loading: true,
        data: [{ id: 1, name: "John" }],
        error: undefined,
        mutate: expect.any(Function),
      });
    }

    {
      const { value } = await itt.next();
      assert(value);
      expect(value).toEqual({
        loading: false,
        data: [{ id: 1, name: "John" }],
        error: undefined,
        mutate: expect.any(Function),
      });
    }

    {
      const { value } = await itt.next();
      assert(value);
      expect(value).toEqual({
        loading: false,
        data: [
          { id: 1, name: "John" },
          { id: 2, name: "Jane" },
        ],
        error: undefined,
        mutate: expect.any(Function),
      });
    }

    {
      const { value } = await itt.next();
      assert(value);
      expect(value).toEqual({
        loading: false,
        data: [
          { id: 1, name: "John" },
          { id: 2, name: "Jane" },
          { id: 3, name: "Jim" },
        ],
        error: undefined,
        mutate: expect.any(Function),
      });
    }
  });
});

describe("computed", () => {
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

  test("Derived from streaming route", async () => {
    const streamFragmentDefinition = defineFragment("stream-fragment").build();
    const streamRoutes = [
      defineRoute({
        method: "GET",
        path: "/users-stream",
        outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
        handler: async () => {
          throw new Error("Not implemented");
        },
      }),
    ] as const;
    const client = createClientBuilder(streamFragmentDefinition, clientConfig, streamRoutes);
    const useUsersStream = client.createHook("/users-stream");

    vi.mocked(global.fetch).mockImplementation(async () => {
      const ctx = new RequestOutputContext(streamRoutes[0].outputSchema);
      return ctx.jsonStream(async (stream) => {
        await stream.write({ id: 1, name: "John" });
        await stream.sleep(1);
        await stream.write({ id: 2, name: "Jane" });
        await stream.sleep(1);
        await stream.write({ id: 3, name: "Jim" });
      });
    });

    const userStore = useUsersStream.store({});

    const names = computed(userStore, ({ data }) => data?.map((user) => user.name).join(", "));
    const itt = createAsyncIteratorFromCallback(names.listen);

    {
      const { value } = await itt.next();
      expect(value).toBe("John");
    }

    {
      const { value } = await itt.next();
      expect(value).toBe("John, Jane");
    }

    {
      const { value } = await itt.next();
      expect(value).toBe("John, Jane, Jim");
    }
  });

  test("Derived from streaming route with atom usage", async () => {
    const streamFragmentDefinition = defineFragment("stream-fragment").build();
    const streamRoutes = [
      defineRoute({
        method: "GET",
        path: "/users-stream",
        outputSchema: z.array(
          z.object({ num: z.number(), status: z.enum(["continue", "half-way", "done"]) }),
        ),
        handler: async () => {
          throw new Error("Not implemented");
        },
      }),
    ] as const;
    const client = createClientBuilder(streamFragmentDefinition, clientConfig, streamRoutes);
    const useUsersStream = client.createHook("/users-stream");

    vi.mocked(global.fetch).mockImplementation(async () => {
      const ctx = new RequestOutputContext(streamRoutes[0].outputSchema);
      return ctx.jsonStream(async (stream) => {
        await stream.write({ num: 8, status: "continue" });
        await stream.sleep(1);
        await stream.write({ num: 17, status: "half-way" });
        await stream.sleep(1);
        await stream.write({ num: 3, status: "done" });
      });
    });

    const userStore = useUsersStream.store({});

    const product = computed(
      userStore,
      ({ data }) => data?.map((user) => user.num).reduce((acc, num) => acc * num, 1) ?? 1,
    );
    const highestNum = atom(0);
    effect([userStore], ({ data }) => {
      if (!Array.isArray(data) || data.length === 0) {
        return;
      }

      const latest = data[data.length - 1];
      highestNum.set(Math.max(highestNum.get(), latest.num));
    });

    const productItt = createAsyncIteratorFromCallback(product.listen);
    const highestNumItt = createAsyncIteratorFromCallback(highestNum.listen);

    {
      const { value } = await productItt.next();
      expect(value).toBe(8);
    }

    {
      const { value } = await productItt.next();
      expect(value).toBe(136);
    }

    {
      const { value } = await productItt.next();
      expect(value).toBe(408);
    }

    {
      const { value } = await highestNumItt.next();
      expect(value).toBe(8);
    }

    {
      const { value } = await highestNumItt.next();
      expect(value).toBe(17);
    }

    // No last value on the highestNum iterator as it will stay '17' and thus no store update is
    // pushed.
  });
});

describe("type guards", () => {
  const testFragment = defineFragment("test-fragment").build();
  const testRoutes = [
    defineRoute({
      method: "GET",
      path: "/users",
      outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
      handler: async (_ctx, { json }) => json([{ id: 1, name: "John" }]),
    }),
    defineRoute({
      method: "POST",
      path: "/users",
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ id: z.number(), name: z.string() }),
      handler: async (_ctx, { json }) => json({ id: 2, name: "Jane" }),
    }),
  ] as const;

  test("isGetHook should correctly identify GET hooks using symbols", () => {
    const client = createClientBuilder(testFragment, {}, testRoutes);
    const getHook = client.createHook("/users");
    const mutatorHook = client.createMutator("POST", "/users");

    expect(isGetHook(getHook)).toBe(true);
    // Test that it correctly identifies non-GET hooks
    expect(isGetHook(mutatorHook)).toBe(false);
  });

  test("isMutatorHook should correctly identify mutator hooks using symbols", () => {
    const client = createClientBuilder(testFragment, {}, testRoutes);
    const getHook = client.createHook("/users");
    const mutatorHook = client.createMutator("POST", "/users");

    expect(isMutatorHook(mutatorHook)).toBe(true);
    // Test that it correctly identifies non-mutator hooks
    expect(isMutatorHook(getHook)).toBe(false);
  });

  test("type guards should work correctly with symbol checking", () => {
    const client = createClientBuilder(testFragment, {}, testRoutes);
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

describe("Custom Fetcher Configuration", () => {
  const testFragment = defineFragment("test-fragment").build();
  const testRoutes = [
    defineRoute({
      method: "GET",
      path: "/users",
      outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
      handler: async (_ctx, { json }) => json([{ id: 1, name: "John" }]),
    }),
    defineRoute({
      method: "POST",
      path: "/users",
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ id: z.number(), name: z.string() }),
      handler: async (_ctx, { json }) => json({ id: 2, name: "Jane" }),
    }),
  ] as const;

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

  test("fragment author sets RequestInit options (credentials)", async () => {
    let capturedOptions: RequestInit | undefined;

    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (_url, options) => {
      capturedOptions = options;
      return {
        headers: new Headers(),
        ok: true,
        json: async () => [{ id: 1, name: "John" }],
      } as Response;
    });

    const client = createClientBuilder(testFragment, clientConfig, testRoutes, {
      type: "options",
      options: { credentials: "include" },
    });

    const useUsers = client.createHook("/users");
    await useUsers.query();

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions?.credentials).toBe("include");
  });

  test("user overrides with their own RequestInit (deep merge)", async () => {
    let capturedOptions: RequestInit | undefined;

    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (_url, options) => {
      capturedOptions = options;
      return {
        headers: new Headers(),
        ok: true,
        json: async () => [{ id: 1, name: "John" }],
      } as Response;
    });

    const authorConfig = { type: "options", options: { credentials: "include" } } as const;
    const userConfig = {
      ...clientConfig,
      fetcherConfig: { type: "options", options: { mode: "cors" } } as const,
    };

    const client = createClientBuilder(testFragment, userConfig, testRoutes, authorConfig);

    const useUsers = client.createHook("/users");
    await useUsers.query();

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions?.credentials).toBe("include");
    expect(capturedOptions?.mode).toBe("cors");
  });

  test("user provides custom fetch function (takes full precedence)", async () => {
    const customFetch = vi.fn(async () => ({
      headers: new Headers(),
      ok: true,
      json: async () => [{ id: 999, name: "Custom" }],
    })) as unknown as typeof fetch;

    const authorConfig = { type: "options", options: { credentials: "include" } } as const;
    const userConfig = {
      ...clientConfig,
      fetcherConfig: { type: "function", fetcher: customFetch } as const,
    };

    const client = createClientBuilder(testFragment, userConfig, testRoutes, authorConfig);

    const useUsers = client.createHook("/users");
    const result = await useUsers.query();

    expect(customFetch).toHaveBeenCalled();
    expect(result).toEqual([{ id: 999, name: "Custom" }]);
  });

  test("author provides custom fetch, user provides RequestInit (user RequestInit used)", async () => {
    const authorFetch = vi.fn(async () => ({
      headers: new Headers(),
      ok: true,
      json: async () => [{ id: 777, name: "Author" }],
    })) as unknown as typeof fetch;

    let capturedOptions: RequestInit | undefined;
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (_url, options) => {
      capturedOptions = options;
      return {
        headers: new Headers(),
        ok: true,
        json: async () => [{ id: 1, name: "John" }],
      } as Response;
    });

    const authorConfig = { type: "function", fetcher: authorFetch } as const;
    const userConfig = {
      ...clientConfig,
      fetcherConfig: { type: "options", options: { credentials: "include" } } as const,
    };

    const client = createClientBuilder(testFragment, userConfig, testRoutes, authorConfig);

    const useUsers = client.createHook("/users");
    await useUsers.query();

    // User's RequestInit takes precedence, so global fetch should be used
    expect(authorFetch).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalled();
    expect(capturedOptions?.credentials).toBe("include");
  });

  test("headers merge correctly (user headers override author headers)", async () => {
    let capturedOptions: RequestInit | undefined;

    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (_url, options) => {
      capturedOptions = options;
      return {
        headers: new Headers(),
        ok: true,
        json: async () => [{ id: 1, name: "John" }],
      } as Response;
    });

    const authorConfig = {
      type: "options",
      options: {
        headers: {
          "X-Author-Header": "author-value",
          "X-Shared-Header": "author-shared",
        },
      },
    } as const;

    const userConfig = {
      ...clientConfig,
      fetcherConfig: {
        type: "options",
        options: {
          headers: {
            "X-User-Header": "user-value",
            "X-Shared-Header": "user-shared",
          },
        },
      } as const,
    };

    const client = createClientBuilder(testFragment, userConfig, testRoutes, authorConfig);

    const useUsers = client.createHook("/users");
    await useUsers.query();

    expect(capturedOptions).toBeDefined();
    const headers = new Headers(capturedOptions?.headers);
    expect(headers.get("X-Author-Header")).toBe("author-value");
    expect(headers.get("X-User-Header")).toBe("user-value");
    expect(headers.get("X-Shared-Header")).toBe("user-shared"); // User overrides
  });

  test("custom fetcher works with mutators", async () => {
    let capturedOptions: RequestInit | undefined;

    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (_url, options) => {
      capturedOptions = options;
      return {
        headers: new Headers(),
        ok: true,
        status: 200,
        json: async () => ({ id: 2, name: "Jane" }),
      } as Response;
    });

    const client = createClientBuilder(testFragment, clientConfig, testRoutes, {
      type: "options",
      options: { credentials: "include" },
    });

    const mutator = client.createMutator("POST", "/users");
    await mutator.mutateQuery({ body: { name: "Jane" } });

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions?.credentials).toBe("include");
    expect(capturedOptions?.method).toBe("POST");
  });

  test("buildUrl method works correctly", () => {
    const client = createClientBuilder(testFragment, clientConfig, testRoutes);

    const url1 = client.buildUrl("/users");
    expect(url1).toBe("http://localhost:3000/api/test-fragment/users");

    const url2 = client.buildUrl("/users/:id", { path: { id: "123" } });
    expect(url2).toBe("http://localhost:3000/api/test-fragment/users/123");

    const url3 = client.buildUrl("/users", { query: { sort: "name", order: "asc" } });
    expect(url3).toBe("http://localhost:3000/api/test-fragment/users?sort=name&order=asc");

    const url4 = client.buildUrl("/users/:id", {
      path: { id: "456" },
      query: { include: "posts" },
    });
    expect(url4).toBe("http://localhost:3000/api/test-fragment/users/456?include=posts");
  });

  test("getFetcher returns correct fetcher and options", () => {
    const customFetch = vi.fn() as unknown as typeof fetch;
    const client = createClientBuilder(
      testFragment,
      {
        ...clientConfig,
        fetcherConfig: { type: "function", fetcher: customFetch },
      },
      testRoutes,
    );

    const { fetcher, defaultOptions } = client.getFetcher();
    expect(fetcher).toBe(customFetch);
    expect(defaultOptions).toBeUndefined();
  });

  test("getFetcher returns default fetch and options", () => {
    const client = createClientBuilder(
      testFragment,
      {
        ...clientConfig,
        fetcherConfig: { type: "options", options: { credentials: "include" } },
      },
      testRoutes,
    );

    const { fetcher, defaultOptions } = client.getFetcher();
    expect(fetcher).toBe(fetch);
    expect(defaultOptions).toBeDefined();
    expect(defaultOptions?.credentials).toBe("include");
  });
});
