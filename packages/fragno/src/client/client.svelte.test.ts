import { test, expect, describe, vi, beforeEach, afterEach, assert } from "vitest";
import { type FragnoPublicClientConfig } from "../mod";
import { createClientBuilder } from "./client";
import { render } from "@testing-library/svelte";
import { defineRoute } from "../api/route";
import { defineLibrary } from "../api/library";
import { z } from "zod";
import { readableToAtom, useFragno } from "./client.svelte";
import { writable, readable, get, derived } from "svelte/store";
import { FragnoClientUnknownApiError } from "./client-error";
import { atom } from "nanostores";
import TestComponent from "./component.test.svelte";

function renderHook(
  clientObj: Record<string, unknown>,
  hookName: string,
  args: Record<string, unknown> = {},
) {
  const { component } = render(TestComponent, {
    props: { clientObj, hookName, args },
  });

  return {
    loading: component["loading"],
    data: component["data"],
    error: component["error"],
  };
}

function renderMutator(
  clientObj: Record<string, unknown>,
  hookName: string,
  args: Record<string, unknown> = {},
) {
  const { component } = render(TestComponent, {
    props: { clientObj, hookName, args },
  });

  return {
    loading: component["loading"],
    data: component["data"],
    error: component["error"],
    mutate: component["mutate"],
  };
}

global.fetch = vi.fn();

describe("readableToAtom", () => {
  test("should create an atom from a readable store", () => {
    const store = readable(123, () => {});
    const a = readableToAtom(store);
    expect(a.get()).toBe(123);
  });

  test("should update the atom when the writable store changes", async () => {
    const store = writable(123);
    const a = readableToAtom(store);
    expect(a.get()).toBe(123);
    store.set(456);
    expect(a.get()).toBe(456);
  });

  test("should work with derived stores", async () => {
    const baseStore = writable(10);
    const derivedStore = derived(baseStore, (value) => value * 2);

    const a = readableToAtom(derivedStore);
    expect(a.get()).toBe(20);

    baseStore.set(5);
    expect(a.get()).toBe(10);
  });
});

describe("createSvelteHook", () => {
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
    const testLibraryDefinition = defineLibrary("test-library");
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

    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      useUsers: client.createHook("/users"),
    };

    const hook = renderHook(clientObj, "useUsers");

    await vi.waitFor(() => {
      expect(get(hook.loading)).toBe(false);
    });

    expect(get(hook.data)).toEqual([{ id: 1, name: "John" }]);
    expect(get(hook.error)).toBeUndefined();
  });

  test("Should support path parameters and update reactively when Svelte store changes", async () => {
    const testLibraryDefinition = defineLibrary("test-library");
    type TestData = {
      id: number;
      name: string;
    };
    const testRoutes = [
      defineRoute({
        method: "GET",
        path: "/users/:id",
        outputSchema: z.object({ id: z.number(), name: z.string() }),
        handler: async ({ pathParams }, { json }) =>
          json({ id: Number(pathParams["id"]), name: "John" } satisfies TestData),
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

    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      useUser: client.createHook("/users/:id"),
    };

    const id = writable("123");

    const hook = renderHook(clientObj, "useUser", { path: { id } });

    await vi.waitFor(() => {
      expect(get(hook.loading)).toBe(false);
    });

    expect(get(hook.data)).toEqual({ id: 123, name: "John" });
    expect(get(hook.error)).toBeUndefined();

    // Update the id value
    id.set("456");

    await vi.waitFor(() => {
      expect((get(hook.data) as TestData | undefined)?.id).toBe(456);
    });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("Should support path parameters and update reactively when Nanostores Atom changes", async () => {
    const testLibraryDefinition = defineLibrary("test-library");
    type TestData = { id: number; name: string };
    const testRoutes = [
      defineRoute({
        method: "GET",
        path: "/users/:id",
        outputSchema: z.object({ id: z.number(), name: z.string() }),
        handler: async ({ pathParams }, { json }) =>
          json({ id: Number(pathParams["id"]), name: "John" } satisfies TestData),
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

    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      useUser: client.createHook("/users/:id"),
    };

    const id = atom("123");

    const hook = renderHook(clientObj, "useUser", { path: { id } });

    await vi.waitFor(() => {
      expect(get(hook.loading)).toBe(false);
    });

    expect(get(hook.data)).toEqual({ id: 123, name: "John" });
    expect(get(hook.error)).toBeUndefined();

    // Update the id value
    id.set("456");

    await vi.waitFor(() => {
      expect((get(hook.data) as TestData | undefined)?.id).toBe(456);
    });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("Should handle errors gracefully", async () => {
    const testLibraryDefinition = defineLibrary("test-library");
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

    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      useUsers: client.createHook("/users"),
    };

    const hook = renderHook(clientObj, "useUsers");

    await vi.waitFor(() => {
      expect(get(hook.loading)).toBe(false);
    });

    expect(get(hook.data)).toBeUndefined();
    expect(get(hook.error)).toBeDefined();
    expect(get(hook.error)).toBeInstanceOf(FragnoClientUnknownApiError);
  });

  test("Should track loading states correctly", async () => {
    const testLibraryDefinition = defineLibrary("test-library");
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

    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      useUsers: client.createHook("/users"),
    };

    const hook = renderHook(clientObj, "useUsers");

    // Initially loading should be true
    expect(get(hook.loading)).toBe(true);
    expect(get(hook.data)).toBeUndefined();
    expect(get(hook.error)).toBeUndefined();

    // Resolve the fetch
    resolvePromise!({
      headers: new Headers(),
      ok: true,
      json: async () => [{ id: 1, name: "John" }],
    } as Response);

    await vi.waitFor(() => {
      expect(get(hook.loading)).toBe(false);
    });

    expect(get(hook.data)).toEqual([{ id: 1, name: "John" }]);
    expect(get(hook.error)).toBeUndefined();
  });

  test("Should handle query parameters", async () => {
    const testLibraryDefinition = defineLibrary("test-library");
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

    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      useUsers: client.createHook("/users"),
    };

    const limit = writable("10");
    const page = writable("1");

    const hook = renderHook(clientObj, "useUsers", { query: { limit, page } });

    await vi.waitFor(() => {
      expect(get(hook.loading)).toBe(false);
    });

    expect(get(hook.data)).toEqual([{ id: 1, name: "John" }]);
    expect(get(hook.error)).toBeUndefined();

    // Update query params
    limit.set("20");
    page.set("2");

    await vi.waitFor(() => {
      expect(vi.mocked(global.fetch).mock.calls.length).toBe(2);
    });

    // Verify the second call has updated params
    const lastCall = vi.mocked(global.fetch).mock.calls[1];
    expect(lastCall[0]).toContain("limit=20");
    expect(lastCall[0]).toContain("page=2");
  });

  test("Should handle multiple hooks together", async () => {
    const testLibraryDefinition = defineLibrary("test-library");
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
    ] as const;

    vi.mocked(global.fetch).mockImplementation(async (input) => {
      assert(typeof input === "string");

      if (input.includes("/users")) {
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
      }

      throw new Error(`Unexpected URL: ${input}`);
    });

    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      useUsers: client.createHook("/users"),
      usePosts: client.createHook("/posts"),
    };

    // Render two separate hooks
    const usersHook = renderHook(clientObj, "useUsers");
    const postsHook = renderHook(clientObj, "usePosts");

    await vi.waitFor(() => {
      expect(get(usersHook.loading)).toBe(false);
      expect(get(postsHook.loading)).toBe(false);
    });

    expect(get(usersHook.data)).toEqual([{ id: 1, name: "John" }]);
    expect(get(postsHook.data)).toEqual([{ id: 1, title: "First Post" }]);
  });

  test("Should handle mixed reactive parameters - writable path param, atom and writable query params, with reactive updates", async () => {
    const testLibraryDefinition = defineLibrary("test-library");
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

    type TestData = {
      id: number;
      title: string;
      category: string;
    };

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
        json: async () =>
          [
            {
              id: Number(userId) * 100,
              title: `Post for user ${userId}`,
              category: `${category}-${limit}-${sort}`,
            },
          ] satisfies TestData[],
      } as Response;
    });

    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      useUserPosts: client.createHook("/users/:id/posts"),
    };

    // Set up reactive parameters
    const userId = writable("1"); // Svelte writable for path parameter
    const limit = atom("10"); // Nanostores atom for query parameter
    const category = writable("tech"); // Svelte writable for query parameter
    const sort = "desc"; // Normal string for query parameter

    const hook = renderHook(clientObj, "useUserPosts", {
      path: { id: userId },
      query: { limit, category, sort },
    });

    // Wait for initial load
    await vi.waitFor(() => {
      expect(get(hook.loading)).toBe(false);
    });

    expect(get(hook.data)).toEqual([
      { id: 100, title: "Post for user 1", category: "tech-10-desc" },
    ]);
    expect(get(hook.error)).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);

    // Verify initial URL construction
    const firstCall = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(firstCall).toContain("/users/1/posts");
    expect(firstCall).toContain("limit=10");
    expect(firstCall).toContain("category=tech");
    expect(firstCall).toContain("sort=desc");

    // Update the Svelte writable path parameter
    userId.set("2");

    await vi.waitFor(() => {
      expect((get(hook.data) as TestData[])?.[0]?.id).toBe(200);
    });

    expect(fetch).toHaveBeenCalledTimes(2);

    // Update the nanostores atom query parameter
    limit.set("20");

    await vi.waitFor(() => {
      expect((get(hook.data) as TestData[])?.[0]?.category?.includes("20")).toBe(true);
    });

    expect(fetch).toHaveBeenCalledTimes(3);

    // Update the Svelte writable query parameter
    category.set("science");

    await vi.waitFor(() => {
      expect((get(hook.data) as TestData[])?.[0]?.category?.includes("science")).toBe(true);
    });

    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

describe("createSvelteMutator", () => {
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

  test("Should handle mutator hooks", async () => {
    const testLibraryDefinition = defineLibrary("test-library");
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

    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      createUser: client.createMutator("POST", "/users"),
    };

    const mutator = renderMutator(clientObj, "createUser");

    expect(get(mutator.loading)).toBe(false);
    expect(get(mutator.data)).toBeUndefined();
    expect(get(mutator.error)).toBeUndefined();

    const result = await mutator.mutate({
      body: { name: "John Doe", email: "john@example.com" },
    });

    expect(result).toEqual({ id: 1, name: "John Doe", email: "john@example.com" });
    expect(get(mutator.data)).toEqual({ id: 1, name: "John Doe", email: "john@example.com" });
    expect(get(mutator.error)).toBeUndefined();
  });

  test("Should handle mutator with path parameters", async () => {
    const testLibraryDefinition = defineLibrary("test-library");
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

    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      updateUser: client.createMutator("PUT", "/users/:id"),
    };

    const mutator = renderMutator(clientObj, "updateUser");

    const userId = writable("42");
    const result = await mutator.mutate({
      body: { name: "Updated Name" },
      path: { id: userId },
    });

    expect(result).toEqual({ id: 42, name: "Updated Name" });
    expect(get(mutator.data)).toEqual({ id: 42, name: "Updated Name" });
    expect(get(mutator.error)).toBeUndefined();

    // Update the writable and call again
    userId.set("100");
    const result2 = await mutator.mutate({
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

  const testLibraryDefinition = defineLibrary("test-library");
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
    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
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

  test("Should support path parameters and update reactively when using Svelte runes", async () => {
    const testLibraryDefinition = defineLibrary("test-library");
    type TestData = {
      id: number;
      name: string;
    };
    const testRoutes = [
      defineRoute({
        method: "GET",
        path: "/users/:id",
        outputSchema: z.object({ id: z.number(), name: z.string() }),
        handler: async ({ pathParams }, { json }) =>
          json({ id: Number(pathParams["id"]), name: "John" } satisfies TestData),
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

    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      useUser: client.createHook("/users/:id"),
    };

    let id = $state("123");

    const hook = renderHook(clientObj, "useUser", { path: { id: () => id } });

    await vi.waitFor(() => {
      expect(get(hook.loading)).toBe(false);
    });

    expect(get(hook.data)).toEqual({ id: 123, name: "John" });
    expect(get(hook.error)).toBeUndefined();

    // Update the id value
    id = "456";

    await vi.waitFor(() => {
      expect((get(hook.data) as TestData | undefined)?.id).toBe(456);
    });

    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
