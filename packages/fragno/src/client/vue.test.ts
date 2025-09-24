import { test, expect, describe, vi, beforeEach, afterEach, assert } from "vitest";
import { type FragnoPublicClientConfig } from "../mod";
import { createClientBuilder } from "./client";
import { defineRoute } from "../api/route";
import { defineFragment } from "../api/fragment";
import { z } from "zod";
import { refToAtom, useFragno } from "./vue";
import { waitFor } from "@testing-library/vue";
import { nextTick, ref, watch } from "vue";
import { FragnoClientUnknownApiError } from "./client-error";
import { atom } from "nanostores";

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
