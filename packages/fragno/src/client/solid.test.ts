import { test, expect, describe, vi, beforeEach, afterEach, assert } from "vitest";
import { atom, computed, type ReadableAtom } from "nanostores";
import { z } from "zod";
import { createClientBuilder } from "./client";
import { useFragno, accessorToAtom, isAccessor } from "./solid";
import { defineRoute } from "../api/route";
import { defineFragment } from "../api/fragment-definition-builder";
import type { FragnoPublicClientConfig } from "../mod";
import { FragnoClientUnknownApiError } from "./client-error";
import { createSignal, createRoot } from "solid-js";

// Mock fetch globally
global.fetch = vi.fn();

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("isAccessor", () => {
  test("should return false for ReadableAtom<string>", () => {
    const testAtom: ReadableAtom<string> = atom("test");
    expect(isAccessor(testAtom)).toBe(false);
  });

  test("should return true for SolidJS Accessor", () => {
    createRoot((dispose) => {
      const [signal] = createSignal("test");
      expect(isAccessor(signal)).toBe(true);
      dispose();
    });
  });

  test("should return false for string", () => {
    expect(isAccessor("test")).toBe(false);
  });

  test("should return false for object", () => {
    expect(isAccessor({ value: "test" })).toBe(false);
  });
});

describe("accessorToAtom", () => {
  test("should create an atom from an accessor", () => {
    createRoot((dispose) => {
      const [signal, _setSignal] = createSignal(123);
      const a = accessorToAtom(signal);
      expect(a.get()).toBe(123);
      dispose();
    });
  });

  test("should update the atom when the accessor changes", async () => {
    createRoot((dispose) => {
      const [signal, setSignal] = createSignal(123);
      const a = accessorToAtom(signal);
      expect(a.get()).toBe(123);
      setSignal(456);
      // Give the effect time to run
      setTimeout(() => {
        expect(a.get()).toBe(456);
        dispose();
      }, 0);
    });
  });
});

describe("createSolidHook", () => {
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

  test("Hook should function", async () => {
    const testFragmentDefinition = defineFragment("test-fragment");
    const testRoutes = [
      defineRoute({
        method: "GET",
        path: "/users",
        outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
        handler: async (_ctx, { json }) => json([{ id: 1, name: "John" }]),
      }),
    ] as const;

    vi.mocked(global.fetch).mockImplementationOnce(
      async () =>
        ({
          headers: new Headers(),
          ok: true,
          json: async () => [{ id: 1, name: "John" }],
        }) as Response,
    );

    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
    const clientObj = {
      useUsers: client.createHook("/users"),
    };

    await createRoot(async (dispose) => {
      try {
        const { useUsers } = useFragno(clientObj);
        const { loading, data, error } = useUsers();

        // Wait for loading to complete
        await sleep(1);

        expect(loading()).toBe(false);
        expect(data()).toEqual([{ id: 1, name: "John" }]);
        expect(error()).toBeUndefined();
      } finally {
        dispose();
      }
    });
  });

  test("Should support path parameters and update reactively when SolidJS signal changes", async () => {
    const testFragmentDefinition = defineFragment("test-fragment");
    const testRoutes = [
      defineRoute({
        method: "GET",
        path: "/users/:id",
        outputSchema: z.object({ id: z.number(), name: z.string() }),
        handler: async ({ pathParams }, { json }) =>
          json({ id: Number(pathParams["id"]), name: "John" }),
      }),
    ] as const;

    // Mock fetch to extract the user ID from the URL and return a user object with that ID.
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

    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
    const clientObj = {
      useUser: client.createHook("/users/:id"),
    };

    await createRoot(async (dispose) => {
      try {
        const [id, setId] = createSignal("123");

        const { useUser } = useFragno(clientObj);
        const { loading, data, error } = useUser({ path: { id } });

        // Wait for initial load
        await sleep(1);

        expect(loading()).toBe(false);
        expect(data()).toEqual({ id: 123, name: "John" });
        expect(error()).toBeUndefined();

        // Update the id value
        setId("456");

        // Wait for the update
        await sleep(1);

        expect(data()).toEqual({ id: 456, name: "John" });
        expect(fetch).toHaveBeenCalledTimes(2);
      } finally {
        dispose();
      }
    });
  });

  test("Should support path parameters and update reactively when Nanostores Atom changes", async () => {
    const testFragmentDefinition = defineFragment("test-fragment");
    const testRoutes = [
      defineRoute({
        method: "GET",
        path: "/users/:id",
        outputSchema: z.object({ id: z.number(), name: z.string() }),
        handler: async ({ pathParams }, { json }) =>
          json({ id: Number(pathParams["id"]), name: "John" }),
      }),
    ] as const;

    // Mock fetch to extract the user ID from the URL and return a user object with that ID.
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

    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
    const clientObj = {
      useUser: client.createHook("/users/:id"),
    };

    await createRoot(async (dispose) => {
      const id = atom("123");

      const { useUser } = useFragno(clientObj);
      const { loading, data, error } = useUser({ path: { id } });

      // Wait for initial load
      await sleep(1);

      expect(loading()).toBe(false);
      expect(data()).toEqual({ id: 123, name: "John" });
      expect(error()).toBeUndefined();

      // Update the id value
      id.set("456");

      // Wait for the update
      await sleep(1);

      expect(data()).toEqual({ id: 456, name: "John" });
      expect(fetch).toHaveBeenCalledTimes(2);

      dispose();
    });
  });

  test("Should handle errors gracefully", async () => {
    const testFragmentDefinition = defineFragment("test-fragment");
    const testRoutes = [
      defineRoute({
        method: "GET",
        path: "/users",
        outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
        handler: async (_ctx, { json }) => json([{ id: 1, name: "John" }]),
      }),
    ] as const;

    vi.mocked(global.fetch).mockImplementationOnce(
      async () =>
        ({
          headers: new Headers(),
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          json: async () => ({ message: "Server error" }),
        }) as Response,
    );

    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
    const clientObj = {
      useUsers: client.createHook("/users"),
    };

    await createRoot(async (dispose) => {
      const { useUsers } = useFragno(clientObj);
      const { loading, data, error } = useUsers();

      // Wait for loading to complete
      await sleep(1);

      expect(loading()).toBe(false);
      expect(data()).toBeUndefined();
      expect(error()).toBeDefined();
      expect(error()).toBeInstanceOf(FragnoClientUnknownApiError);

      dispose();
    });
  });

  test("Should handle query parameters", async () => {
    const testFragmentDefinition = defineFragment("test-fragment");
    const testRoutes = [
      defineRoute({
        method: "GET",
        path: "/users",
        outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
        handler: async (_ctx, { json }) => json([{ id: 1, name: "John" }]),
      }),
    ] as const;

    vi.mocked(global.fetch).mockImplementation(async (input) => {
      assert(typeof input === "string");
      expect(input).toContain("limit=10");
      expect(input).toContain("page=1");

      return {
        headers: new Headers(),
        ok: true,
        json: async () => [{ id: 1, name: "John" }],
      } as Response;
    });

    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
    const clientObj = {
      useUsers: client.createHook("/users"),
    };

    await createRoot(async (dispose) => {
      const [limit, setLimit] = createSignal("10");
      const [page, setPage] = createSignal("1");

      const { useUsers } = useFragno(clientObj);
      const { loading, data, error } = useUsers({ query: { limit, page } });

      // Wait for initial load
      await sleep(1);

      expect(loading()).toBe(false);
      expect(data()).toEqual([{ id: 1, name: "John" }]);
      expect(error()).toBeUndefined();

      // Update query params
      setLimit("20");
      setPage("2");

      // Wait for the update
      await sleep(1);

      expect(fetch).toHaveBeenCalledTimes(2);

      // Verify the second call has updated params
      const lastCall = vi.mocked(global.fetch).mock.calls[1];
      expect(lastCall[0]).toContain("limit=20");
      expect(lastCall[0]).toContain("page=2");

      dispose();
    });
  });

  test("Should handle multiple hooks together", async () => {
    const testFragmentDefinition = defineFragment("test-fragment");
    const testRoutes = [
      defineRoute({
        method: "GET",
        path: "/users",
        outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
        handler: async (_ctx, { json }) => json([{ id: 1, name: "John" }]),
      }),
      defineRoute({
        method: "GET",
        path: "/posts",
        outputSchema: z.array(z.object({ id: z.number(), title: z.string() })),
        handler: async (_ctx, { json }) => json([{ id: 1, title: "First Post" }]),
      }),
      defineRoute({
        method: "DELETE",
        path: "/users/:id",
        inputSchema: z.object({}),
        outputSchema: z.object({ success: z.boolean() }),
        handler: async (_ctx, { json }) => json({ success: true }),
      }),
    ] as const;

    vi.mocked(global.fetch).mockImplementation(async (input) => {
      assert(typeof input === "string");

      if (input.includes("/users") && !input.includes("/users/")) {
        return {
          headers: new Headers(),
          ok: true,
          json: async () => [{ id: 1, name: "John" }],
        } as Response;
      } else if (input.includes("/posts")) {
        return {
          headers: new Headers(),
          ok: true,
          json: async () => [{ id: 1, title: "First Post" }],
        } as Response;
      } else if (input.includes("/users/")) {
        return {
          headers: new Headers(),
          ok: true,
          json: async () => ({ success: true }),
        } as Response;
      }

      throw new Error(`Unexpected URL: ${input}`);
    });

    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
    const clientObj = {
      useUsers: client.createHook("/users"),
      usePosts: client.createHook("/posts"),
      deleteUser: client.createMutator("DELETE", "/users/:id"),
    };

    await createRoot(async (dispose) => {
      const { useUsers, usePosts, deleteUser } = useFragno(clientObj);

      // Use multiple hooks
      const users = useUsers();
      const posts = usePosts();
      const deleter = deleteUser();

      // Wait for loading to complete
      await sleep(1);

      expect(users.loading()).toBe(false);
      expect(posts.loading()).toBe(false);
      expect(users.data()).toEqual([{ id: 1, name: "John" }]);
      expect(posts.data()).toEqual([{ id: 1, title: "First Post" }]);

      // Use the mutator
      const result = await deleter.mutate({
        body: {},
        path: { id: "1" },
      });

      expect(result).toEqual({ success: true });

      dispose();
    });
  });

  test("Should handle mixed reactive parameters - signal path param, atom and signal query params, with reactive updates", async () => {
    const testFragmentDefinition = defineFragment("test-fragment");
    const testRoutes = [
      defineRoute({
        method: "GET",
        path: "/users/:id/posts",
        inputSchema: z.object({
          limit: z.string().optional(),
          category: z.string().optional(),
          sort: z.string().optional(),
        }),
        outputSchema: z.array(
          z.object({ id: z.number(), title: z.string(), category: z.string() }),
        ),
        handler: async (_ctx, { empty }) => empty(),
      }),
    ] as const;

    // Mock fetch to verify URL construction and parameter passing
    vi.mocked(global.fetch).mockImplementation(async (input) => {
      assert(typeof input === "string");

      // Extract user ID from path
      const [, userId] = String(input).match(/\/users\/([^/]+)\/posts/) ?? [];
      expect(userId).toBeDefined();
      expect(+userId).not.toBeNaN();

      // Parse query parameters
      const url = new URL(input);
      const limit = url.searchParams.get("limit") || "5";
      const category = url.searchParams.get("category") || "general";
      const sort = url.searchParams.get("sort") || "asc";

      return {
        headers: new Headers(),
        ok: true,
        json: async () => [
          {
            id: Number(userId) * 100,
            title: `Post for user ${userId}`,
            category: `${category}-${limit}-${sort}`,
          },
        ],
      } as Response;
    });

    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
    const clientObj = {
      useUserPosts: client.createHook("/users/:id/posts"),
    };

    await createRoot(async (dispose) => {
      // Set up reactive parameters
      const [userId, setUserId] = createSignal("1"); // SolidJS signal for path parameter
      const limit = atom("10"); // Nanostores atom for query parameter
      const [category, setCategory] = createSignal("tech"); // SolidJS signal for query parameter
      const sort = "desc"; // Normal string for query parameter

      const { useUserPosts } = useFragno(clientObj);
      const { loading, data, error } = useUserPosts({
        path: { id: userId },
        query: { limit, category, sort },
      });

      // Wait for initial load
      await sleep(1);

      expect(loading()).toBe(false);
      expect(data()).toEqual([{ id: 100, title: "Post for user 1", category: "tech-10-desc" }]);
      expect(error()).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);

      // Verify initial URL construction
      const firstCall = vi.mocked(global.fetch).mock.calls[0][0] as string;
      expect(firstCall).toContain("/users/1/posts");
      expect(firstCall).toContain("limit=10");
      expect(firstCall).toContain("category=tech");
      expect(firstCall).toContain("sort=desc");

      // Update the SolidJS signal path parameter
      setUserId("2");

      await sleep(1);

      expect(data()).toEqual([{ id: 200, title: "Post for user 2", category: "tech-10-desc" }]);
      expect(fetch).toHaveBeenCalledTimes(2);

      // Verify the second call has updated path param
      const secondCall = vi.mocked(global.fetch).mock.calls[1][0] as string;
      expect(secondCall).toContain("/users/2/posts");
      expect(secondCall).toContain("limit=10");
      expect(secondCall).toContain("category=tech");
      expect(secondCall).toContain("sort=desc");

      // Update the nanostores atom query parameter
      limit.set("20");

      await sleep(1);

      expect(data()).toEqual([{ id: 200, title: "Post for user 2", category: "tech-20-desc" }]);
      expect(fetch).toHaveBeenCalledTimes(3);

      // Verify the third call has updated atom query param
      const thirdCall = vi.mocked(global.fetch).mock.calls[2][0] as string;
      expect(thirdCall).toContain("/users/2/posts");
      expect(thirdCall).toContain("limit=20");
      expect(thirdCall).toContain("category=tech");
      expect(thirdCall).toContain("sort=desc");

      // Update the SolidJS signal query parameter
      setCategory("science");

      await sleep(1);

      expect(data()).toEqual([{ id: 200, title: "Post for user 2", category: "science-20-desc" }]);
      expect(fetch).toHaveBeenCalledTimes(4);

      // Verify the fourth call has updated signal query param
      const fourthCall = vi.mocked(global.fetch).mock.calls[3][0] as string;
      expect(fourthCall).toContain("/users/2/posts");
      expect(fourthCall).toContain("limit=20");
      expect(fourthCall).toContain("category=science");
      expect(fourthCall).toContain("sort=desc");

      // Update both reactive parameters simultaneously
      setUserId("3");
      limit.set("5");
      setCategory("news");

      await sleep(1);

      expect(data()).toEqual([{ id: 300, title: "Post for user 3", category: "news-5-desc" }]);
      expect(fetch).toHaveBeenCalledTimes(5);

      // Verify the final call has all updated parameters
      const finalCall = vi.mocked(global.fetch).mock.calls[4][0] as string;
      expect(finalCall).toContain("/users/3/posts");
      expect(finalCall).toContain("limit=5");
      expect(finalCall).toContain("category=news");
      expect(finalCall).toContain("sort=desc"); // Static parameter should remain unchanged

      dispose();
    });
  });
});

describe("createSolidMutator", () => {
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

  test("Should handle mutator with path parameters", async () => {
    const testFragmentDefinition = defineFragment("test-fragment");
    const testRoutes = [
      defineRoute({
        method: "PUT",
        path: "/users/:id",
        inputSchema: z.object({ name: z.string() }),
        outputSchema: z.object({ id: z.number(), name: z.string() }),
        handler: async ({ pathParams, input }, { json }) => {
          const { name } = await input.valid();
          return json({ id: Number(pathParams["id"]), name });
        },
      }),
    ] as const;

    vi.mocked(global.fetch).mockImplementation(async (input) => {
      assert(typeof input === "string");
      const [, id] = String(input).match(/\/users\/([^/]+)/) ?? [];

      return {
        headers: new Headers(),
        ok: true,
        json: async () => ({ id: Number(id), name: "Updated Name" }),
      } as Response;
    });

    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
    const clientObj = {
      updateUser: client.createMutator("PUT", "/users/:id"),
    };

    await createRoot(async (dispose) => {
      const { updateUser } = useFragno(clientObj);
      const { mutate, data, error } = updateUser();

      const [userId, setUserId] = createSignal("42");
      const result = await mutate({
        body: { name: "Updated Name" },
        path: { id: userId },
      });

      expect(result).toEqual({ id: 42, name: "Updated Name" });
      expect(data()).toEqual({ id: 42, name: "Updated Name" });
      expect(error()).toBeUndefined();

      // Update the signal and call again
      setUserId("100");
      const result2 = await mutate({
        body: { name: "Another Name" },
        path: { id: userId },
      });
      expect(error()).toBeUndefined();
      expect(result2).toEqual({ id: 100, name: "Updated Name" });
      expect(data()).toEqual({ id: 100, name: "Updated Name" });

      dispose();
    });
  });
});

describe("useFragno", () => {
  const clientConfig: FragnoPublicClientConfig = {
    baseUrl: "http://localhost:3000",
  };

  const testFragmentDefinition = defineFragment("test-fragment");
  const testRoutes = [
    defineRoute({
      method: "GET",
      path: "/data",
      outputSchema: z.string(),
      handler: async (_ctx, { json }) => json("test data"),
    }),
    defineRoute({
      method: "POST",
      path: "/action",
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ result: z.string() }),
      handler: async (_ctx, { json }) => json({ result: "test value" }),
    }),
  ] as const;

  test("should pass through non-hook values unchanged", () => {
    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
    const clientObj = {
      useData: client.createHook("/data"),
      usePostAction: client.createMutator("POST", "/action"),
      someString: "hello world",
      someNumber: 42,
      someObject: { foo: "bar", nested: { value: true } },
      someArray: [1, 2, 3],
      someFunction: () => "test",
      someNull: null,
      someUndefined: undefined,
    };

    const result = useFragno(clientObj);

    // Check that non-hook values are passed through unchanged
    expect(result.someString).toBe("hello world");
    expect(result.someNumber).toBe(42);
    expect(result.someObject).toEqual({ foo: "bar", nested: { value: true } });
    expect(result.someArray).toEqual([1, 2, 3]);
    expect(result.someFunction()).toBe("test");
    expect(result.someNull).toBeNull();
    expect(result.someUndefined).toBeUndefined();

    // Verify that hooks are still transformed
    expect(typeof result.useData).toBe("function");
    expect(typeof result.usePostAction).toBe("function");
  });
});

describe("createSolidStore", () => {
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

  test("should wrap atom fields with useStore", () => {
    const stringAtom: ReadableAtom<string> = atom("hello");
    const numberAtom: ReadableAtom<number> = atom(42);
    const booleanAtom: ReadableAtom<boolean> = atom(true);

    const cb = createClientBuilder(defineFragment("test-fragment"), clientConfig, []);
    const client = {
      useStore: cb.createStore({
        message: stringAtom,
        count: numberAtom,
        isActive: booleanAtom,
      }),
    };

    createRoot((dispose) => {
      const { useStore } = useFragno(client);

      const { message, count, isActive } = useStore();

      // The store should return accessors
      expect(typeof message).toBe("function");
      expect(typeof count).toBe("function");
      expect(typeof isActive).toBe("function");

      // Calling the accessors should return the values
      expect(message()).toBe("hello");
      expect(count()).toBe(42);
      expect(isActive()).toBe(true);

      dispose();
    });
  });

  test("should handle computed stores", () => {
    const baseNumber = atom(10);
    const doubled = computed(baseNumber, (n) => n * 2);
    const tripled = computed(baseNumber, (n) => n * 3);

    const cb = createClientBuilder(defineFragment("test-fragment"), clientConfig, []);
    const client = {
      useComputedValues: cb.createStore({
        base: baseNumber,
        doubled: doubled,
        tripled: tripled,
      }),
    };

    createRoot((dispose) => {
      const { useComputedValues } = useFragno(client);

      const { base, doubled, tripled } = useComputedValues();

      expect(base()).toBe(10);
      expect(doubled()).toBe(20);
      expect(tripled()).toBe(30);

      // Update base and verify reactivity
      baseNumber.set(7);

      // Give reactivity time to propagate
      setTimeout(() => {
        expect(base()).toBe(7);
        expect(doubled()).toBe(14);
        expect(tripled()).toBe(21);

        dispose();
      }, 0);
    });
  });

  test("should pass through non-atom values unchanged", () => {
    const messageAtom: ReadableAtom<string> = atom("test");
    const regularFunction = (x: number) => x * 2;
    const regularObject = { foo: "bar", baz: 123 };

    const cb = createClientBuilder(defineFragment("test-fragment"), clientConfig, []);
    const client = {
      useMixed: cb.createStore({
        message: messageAtom,
        multiply: regularFunction,
        config: regularObject,
        constant: 42,
      }),
    };

    createRoot((dispose) => {
      const { useMixed } = useFragno(client);
      const { message, config, constant, multiply } = useMixed();

      // Atom should be wrapped
      expect(typeof message).toBe("function");
      expect(message()).toBe("test");

      // Non-atom values should be passed through
      expect(multiply(5)).toBe(10);
      expect(config).toEqual({ foo: "bar", baz: 123 });
      expect(constant).toBe(42);

      dispose();
    });
  });

  test("should handle single atom as store", () => {
    const singleAtom: ReadableAtom<string> = atom("single");
    const cb = createClientBuilder(defineFragment("test-fragment"), clientConfig, []);

    const client = {
      useSingle: cb.createStore(singleAtom),
    };

    createRoot((dispose) => {
      const { useSingle } = useFragno(client);

      // Single atom should be wrapped as accessor
      expect(typeof useSingle).toBe("function");
      expect(useSingle()).toBe("single");

      dispose();
    });
  });
});
