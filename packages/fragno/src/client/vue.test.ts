import { test, expect, describe, vi, beforeEach, afterEach, assert, expectTypeOf } from "vitest";
import { type FragnoPublicClientConfig } from "./client";
import { createClientBuilder } from "./client";
import { defineRoute } from "../api/route";
import { defineFragment } from "../api/fragment-definition-builder";
import { z } from "zod";
import { refToAtom, useFragno } from "./vue";
import { waitFor } from "@testing-library/vue";
import { nextTick, ref, watch, effectScope } from "vue";
import { FragnoClientUnknownApiError } from "./client-error";
import { atom, computed, type ReadableAtom } from "nanostores";

global.fetch = vi.fn();

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("refToAtom", () => {
  test("should create an atom from a ref", () => {
    const r = ref(123);
    const a = refToAtom(r);
    expect(a.get()).toBe(123);
  });

  test("should update the atom when the ref changes", async () => {
    const r = ref(123);
    const a = refToAtom(r);
    expect(a.get()).toBe(123);
    r.value = 456;
    await sleep(0);
    expect(a.get()).toBe(456);
  });

  test("ref nested in object", async () => {
    const obj = ref({ a: 1, nested: { b: 2 } });

    let listenExecuted = false;
    watch(
      obj,
      (newObj) => {
        expect(newObj.a).toBe(3);
        expect(newObj.nested.b).toBe(5);
        listenExecuted = true;
      },
      { deep: true },
    );

    obj.value.a = 3;
    obj.value.nested.b = 5;

    await nextTick();
    expect(listenExecuted).toBe(true);
  });
});

describe("createVueHook", () => {
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

    const { useUsers } = useFragno(clientObj);
    const { loading, data, error } = useUsers();

    await waitFor(() => {
      expect(loading.value).toBe(false);
    });

    expect(data.value).toEqual([{ id: 1, name: "John" }]);
    expect(error.value).toBeUndefined();
  });

  test("Should support path parameters and update reactively when Vue ref changes", async () => {
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

    const id = ref("123");

    const { useUser } = useFragno(clientObj);
    const { loading, data, error } = useUser({ path: { id } });

    await waitFor(() => {
      expect(loading.value).toBe(false);
    });

    expect(data.value).toEqual({ id: 123, name: "John" });
    expect(error.value).toBeUndefined();

    // Update the id value
    id.value = "456";

    await waitFor(() => {
      expect(data.value).toEqual({ id: 456, name: "John" });
    });

    expect(fetch).toHaveBeenCalledTimes(2);
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

    const id = atom("123");

    const { useUser } = useFragno(clientObj);
    const { loading, data, error } = useUser({ path: { id } });

    await waitFor(() => {
      expect(loading.value).toBe(false);
    });

    expect(data.value).toEqual({ id: 123, name: "John" });
    expect(error.value).toBeUndefined();

    // Update the id value
    id.set("456");

    await waitFor(() => {
      expect(data.value).toEqual({ id: 456, name: "John" });
    });

    expect(fetch).toHaveBeenCalledTimes(2);
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

    const { useUsers } = useFragno(clientObj);
    const { loading, data, error } = useUsers();

    await waitFor(() => {
      expect(loading.value).toBe(false);
    });

    expect(data.value).toBeUndefined();
    expect(error.value).toBeDefined();
    expect(error.value).toBeInstanceOf(FragnoClientUnknownApiError);
  });

  test("Should track loading states correctly", async () => {
    const testFragmentDefinition = defineFragment("test-fragment");
    const testRoutes = [
      defineRoute({
        method: "GET",
        path: "/users",
        outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
        handler: async (_ctx, { json }) => json([{ id: 1, name: "John" }]),
      }),
    ] as const;

    let resolvePromise: (value: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolvePromise = resolve;
    });

    vi.mocked(global.fetch).mockImplementationOnce(() => fetchPromise);

    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
    const clientObj = {
      useUsers: client.createHook("/users"),
    };

    const { useUsers } = useFragno(clientObj);
    const { loading, data, error } = useUsers();

    // Initially loading should be true
    expect(loading.value).toBe(true);
    expect(data.value).toBeUndefined();
    expect(error.value).toBeUndefined();

    // Resolve the fetch
    resolvePromise!({
      headers: new Headers(),
      ok: true,
      json: async () => [{ id: 1, name: "John" }],
    } as Response);

    await waitFor(() => {
      expect(loading.value).toBe(false);
    });

    expect(data.value).toEqual([{ id: 1, name: "John" }]);
    expect(error.value).toBeUndefined();
  });

  test("Should handle mutator hooks", async () => {
    const testFragmentDefinition = defineFragment("test-fragment");
    const testRoutes = [
      defineRoute({
        method: "POST",
        path: "/users",
        inputSchema: z.object({ name: z.string(), email: z.string() }),
        outputSchema: z.object({ id: z.number(), name: z.string(), email: z.string() }),
        handler: async ({ input }, { json }) => {
          const { name, email } = await input.valid();
          return json({ id: 1, name, email });
        },
      }),
    ] as const;

    vi.mocked(global.fetch).mockImplementationOnce(
      async () =>
        ({
          headers: new Headers(),
          ok: true,
          json: async () => ({ id: 1, name: "John Doe", email: "john@example.com" }),
        }) as Response,
    );

    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
    const clientObj = {
      createUser: client.createMutator("POST", "/users"),
    };

    const { createUser } = useFragno(clientObj);
    const { mutate, loading, data, error } = createUser();

    expect(loading.value).toBe(false);
    expect(data.value).toBeUndefined();
    expect(error.value).toBeUndefined();

    const result = await mutate({
      body: { name: "John Doe", email: "john@example.com" },
    });

    expect(result).toEqual({ id: 1, name: "John Doe", email: "john@example.com" });
    expect(data.value).toEqual({ id: 1, name: "John Doe", email: "john@example.com" });
    expect(error.value).toBeUndefined();
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

    const limit = ref("10");
    const page = ref("1");

    const { useUsers } = useFragno(clientObj);
    const { loading, data, error } = useUsers({ query: { limit, page } });

    await waitFor(() => {
      expect(loading.value).toBe(false);
    });

    expect(data.value).toEqual([{ id: 1, name: "John" }]);
    expect(error.value).toBeUndefined();

    // Update query params
    limit.value = "20";
    page.value = "2";

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    // Verify the second call has updated params
    const lastCall = vi.mocked(global.fetch).mock.calls[1];
    expect(lastCall[0]).toContain("limit=20");
    expect(lastCall[0]).toContain("page=2");
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

    const { useUsers, usePosts, deleteUser } = useFragno(clientObj);

    // Use multiple hooks
    const users = useUsers();
    const posts = usePosts();
    const deleter = deleteUser();

    await waitFor(() => {
      expect(users.loading.value).toBe(false);
      expect(posts.loading.value).toBe(false);
    });

    expect(users.data.value).toEqual([{ id: 1, name: "John" }]);
    expect(posts.data.value).toEqual([{ id: 1, title: "First Post" }]);

    // Use the mutator
    const result = await deleter.mutate({
      body: {},
      path: { id: "1" },
    });

    expect(result).toEqual({ success: true });
  });

  test("Should handle mixed reactive parameters - ref path param, atom and ref query params, with reactive updates", async () => {
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

    // Set up reactive parameters
    const userId = ref("1"); // Vue ref for path parameter
    const limit = atom("10"); // Nanostores atom for query parameter
    const category = ref("tech"); // Vue ref for query parameter
    const sort = "desc"; // Normal string for query parameter

    const { useUserPosts } = useFragno(clientObj);
    const { loading, data, error } = useUserPosts({
      path: { id: userId },
      query: { limit, category, sort },
    });

    // Wait for initial load
    await waitFor(() => {
      expect(loading.value).toBe(false);
    });

    expect(data.value).toEqual([{ id: 100, title: "Post for user 1", category: "tech-10-desc" }]);
    expect(error.value).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);

    // Verify initial URL construction
    const firstCall = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(firstCall).toContain("/users/1/posts");
    expect(firstCall).toContain("limit=10");
    expect(firstCall).toContain("category=tech");
    expect(firstCall).toContain("sort=desc");

    // Update the Vue ref path parameter
    userId.value = "2";

    await waitFor(() => {
      expect(data.value).toEqual([{ id: 200, title: "Post for user 2", category: "tech-10-desc" }]);
    });

    expect(fetch).toHaveBeenCalledTimes(2);

    // Verify the second call has updated path param
    const secondCall = vi.mocked(global.fetch).mock.calls[1][0] as string;
    expect(secondCall).toContain("/users/2/posts");
    expect(secondCall).toContain("limit=10");
    expect(secondCall).toContain("category=tech");
    expect(secondCall).toContain("sort=desc");

    // Update the nanostores atom query parameter
    limit.set("20");

    await waitFor(() => {
      expect(data.value).toEqual([{ id: 200, title: "Post for user 2", category: "tech-20-desc" }]);
    });

    expect(fetch).toHaveBeenCalledTimes(3);

    // Verify the third call has updated atom query param
    const thirdCall = vi.mocked(global.fetch).mock.calls[2][0] as string;
    expect(thirdCall).toContain("/users/2/posts");
    expect(thirdCall).toContain("limit=20");
    expect(thirdCall).toContain("category=tech");
    expect(thirdCall).toContain("sort=desc");

    // Update the Vue ref query parameter
    category.value = "science";

    await waitFor(() => {
      expect(data.value).toEqual([
        { id: 200, title: "Post for user 2", category: "science-20-desc" },
      ]);
    });

    expect(fetch).toHaveBeenCalledTimes(4);

    // Verify the fourth call has updated ref query param
    const fourthCall = vi.mocked(global.fetch).mock.calls[3][0] as string;
    expect(fourthCall).toContain("/users/2/posts");
    expect(fourthCall).toContain("limit=20");
    expect(fourthCall).toContain("category=science");
    expect(fourthCall).toContain("sort=desc");

    // Update both reactive parameters simultaneously
    userId.value = "3";
    limit.set("5");
    category.value = "news";

    await waitFor(() => {
      expect(data.value).toEqual([{ id: 300, title: "Post for user 3", category: "news-5-desc" }]);
    });

    expect(fetch).toHaveBeenCalledTimes(5);

    // Verify the final call has all updated parameters
    const finalCall = vi.mocked(global.fetch).mock.calls[4][0] as string;
    expect(finalCall).toContain("/users/3/posts");
    expect(finalCall).toContain("limit=5");
    expect(finalCall).toContain("category=news");
    expect(finalCall).toContain("sort=desc"); // Static parameter should remain unchanged
  });
});

describe("createVueMutator", () => {
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

    const { updateUser } = useFragno(clientObj);
    const { mutate, data, error } = updateUser();

    const userId = ref("42");
    const result = await mutate({
      body: { name: "Updated Name" },
      path: { id: userId },
    });

    expect(result).toEqual({ id: 42, name: "Updated Name" });
    expect(data.value).toEqual({ id: 42, name: "Updated Name" });
    expect(error.value).toBeUndefined();

    // Update the ref and call again
    userId.value = "100";
    const result2 = await mutate({
      body: { name: "Another Name" },
      path: { id: userId },
    });

    expect(result2).toEqual({ id: 100, name: "Updated Name" });
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

describe("useFragno - createStore", () => {
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

  test("FragnoVueStore type test - ReadableAtom fields", () => {
    // Test that ReadableAtom fields are properly unwrapped to their value types
    const stringAtom: ReadableAtom<string> = atom("hello");
    const numberAtom: ReadableAtom<number> = atom(42);
    const booleanAtom: ReadableAtom<boolean> = atom(true);
    const objectAtom: ReadableAtom<{ count: number }> = atom({ count: 0 });
    const arrayAtom: ReadableAtom<string[]> = atom(["a", "b", "c"]);

    const cb = createClientBuilder(defineFragment("test-fragment"), clientConfig, []);
    const client = {
      useStore: cb.createStore({
        message: stringAtom,
        count: numberAtom,
        isActive: booleanAtom,
        data: objectAtom,
        items: arrayAtom,
      }),
    };

    const { useStore } = useFragno(client);

    // Type assertions to ensure the types are correctly inferred
    expectTypeOf(useStore).toExtend<
      () => {
        message: string;
        count: number;
        isActive: boolean;
        data: { count: number };
        items: string[];
      }
    >();

    // Runtime test - need to run in effect scope for Vue reactivity
    const scope = effectScope();
    scope.run(() => {
      const result = useStore();
      expect(result.message).toBe("hello");
      expect(result.count).toBe(42);
      expect(result.isActive).toBe(true);
      expect(result.data).toEqual({ count: 0 });
      expect(result.items).toEqual(["a", "b", "c"]);
    });
    scope.stop();
  });

  test("FragnoVueStore type test - computed stores", () => {
    // Test that computed stores (which are also ReadableAtom) are properly unwrapped
    const baseNumber = atom(10);
    const doubled = computed(baseNumber, (n) => n * 2);
    const tripled = computed(baseNumber, (n) => n * 3);
    const combined = computed([doubled, tripled], (d, t) => ({ doubled: d, tripled: t }));

    const cb = createClientBuilder(defineFragment("test-fragment"), clientConfig, []);
    const client = {
      useComputedValues: cb.createStore({
        base: baseNumber,
        doubled: doubled,
        tripled: tripled,
        combined: combined,
      }),
    };

    const { useComputedValues } = useFragno(client);

    // Type assertions
    expectTypeOf(useComputedValues).toExtend<
      () => {
        base: number;
        doubled: number;
        tripled: number;
        combined: { doubled: number; tripled: number };
      }
    >();

    // Runtime test
    const scope = effectScope();
    scope.run(() => {
      const result = useComputedValues();
      expect(result.base).toBe(10);
      expect(result.doubled).toBe(20);
      expect(result.tripled).toBe(30);
      expect(result.combined).toEqual({ doubled: 20, tripled: 30 });
    });
    scope.stop();
  });

  test("FragnoVueStore type test - mixed store and non-store fields", () => {
    // Test that non-store fields are passed through unchanged
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

    const { useMixed } = useFragno(client);

    // Type assertions
    expectTypeOf(useMixed).toExtend<
      () => {
        message: string;
        multiply: (x: number) => number;
        config: { foo: string; baz: number };
        constant: number;
      }
    >();

    // Runtime test
    const scope = effectScope();
    scope.run(() => {
      const result = useMixed();
      expect(result.message).toBe("test");
      expect(result.multiply(5)).toBe(10);
      expect(result.config).toEqual({ foo: "bar", baz: 123 });
      expect(result.constant).toBe(42);
    });
    scope.stop();
  });

  test("FragnoVueStore type test - single store vs object with stores", () => {
    // Test that a single store is unwrapped directly
    const singleAtom: ReadableAtom<string> = atom("single");
    const cb = createClientBuilder(defineFragment("test-fragment"), clientConfig, []);

    // Single store case
    const clientSingle = {
      useSingle: cb.createStore(singleAtom),
    };
    const { useSingle } = useFragno(clientSingle);
    expectTypeOf(useSingle).toExtend<() => string>();

    // Object with stores case
    const clientObject = {
      useObject: cb.createStore({
        value: singleAtom,
      }),
    };
    const { useObject } = useFragno(clientObject);
    expectTypeOf(useObject).toExtend<() => { value: string }>();

    // Runtime test
    const scope = effectScope();
    scope.run(() => {
      const singleResult = useSingle();
      expect(singleResult).toBe("single");

      const objectResult = useObject();
      expect(objectResult).toEqual({ value: "single" });
    });
    scope.stop();
  });

  test("FragnoVueStore type test - complex nested atoms", () => {
    // Test complex nested structures with atoms
    type User = { id: number; name: string; email: string };
    type Settings = { theme: "light" | "dark"; notifications: boolean };

    const userAtom: ReadableAtom<User> = atom({ id: 1, name: "John", email: "john@example.com" });
    const settingsAtom: ReadableAtom<Settings> = atom({ theme: "light", notifications: true });
    const loadingAtom: ReadableAtom<boolean> = atom(false);
    const errorAtom: ReadableAtom<string | null> = atom(null);

    const cb = createClientBuilder(defineFragment("test-fragment"), clientConfig, []);
    const client = {
      useAppState: cb.createStore({
        user: userAtom,
        settings: settingsAtom,
        loading: loadingAtom,
        error: errorAtom,
      }),
    };

    const { useAppState } = useFragno(client);

    // Type assertions for complex nested structure
    expectTypeOf(useAppState).toExtend<
      () => {
        user: User;
        settings: Settings;
        loading: boolean;
        error: string | null;
      }
    >();

    // Runtime test
    const scope = effectScope();
    scope.run(() => {
      const result = useAppState();
      expect(result.user).toEqual({ id: 1, name: "John", email: "john@example.com" });
      expect(result.settings).toEqual({ theme: "light", notifications: true });
      expect(result.loading).toBe(false);
      expect(result.error).toBeNull();
    });
    scope.stop();
  });

  test("FragnoVueStore - reactivity with atom updates", async () => {
    // Test that stores are reactive and update when atoms change
    const countAtom = atom(0);

    const cb = createClientBuilder(defineFragment("test-fragment"), clientConfig, []);
    const client = {
      useCounter: cb.createStore({
        count: countAtom,
      }),
    };

    const { useCounter } = useFragno(client);

    const scope = effectScope();
    let result: { count: number } | undefined;
    scope.run(() => {
      result = useCounter();
      expect(result.count).toBe(0);
    });

    // Update the atom
    countAtom.set(5);

    // Re-run in scope to get updated value
    scope.run(() => {
      result = useCounter();
      expect(result.count).toBe(5);
    });

    scope.stop();
  });
});
