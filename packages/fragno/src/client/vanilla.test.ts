import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";
import { atom } from "nanostores";
import { z } from "zod";
import { createClientBuilder, clearHooksCache } from "./client";
import { useFragno } from "./vanilla";
import { addRoute } from "../api/api";
import type { FragnoPublicClientConfig } from "../mod";
import { FragnoClientFetchNetworkError } from "./client-error";

// Mock fetch globally
global.fetch = vi.fn();

// Utility function to wait for async iterator until condition is met
async function waitForAsyncIterator<T>(
  iterable: AsyncIterable<T>,
  condition: (value: T) => boolean,
  options: { timeout?: number } = {},
): Promise<T> {
  const { timeout = 1000 } = options;
  const startTime = Date.now();

  for await (const value of iterable) {
    if (condition(value)) {
      return value;
    }

    if (Date.now() - startTime > timeout) {
      throw new Error(`waitForAsyncIterator: Timeout after ${timeout}ms`);
    }
  }

  throw new Error("waitForAsyncIterator: Iterator completed without meeting condition");
}

describe("createVanillaListeners", () => {
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
        method: "GET",
        path: "/users/:id",
        outputSchema: z.object({ id: z.number(), name: z.string() }),
        handler: async ({ pathParams }, { json }) =>
          json({ id: Number(pathParams["id"]), name: "John" }),
      }),
      addRoute({
        method: "GET",
        path: "/search",
        outputSchema: z.array(z.string()),
        handler: async (_ctx, { json }) => json(["result1", "result2"]),
      }),
    ],
  } as const;

  const clientConfig: FragnoPublicClientConfig = {
    baseUrl: "http://localhost:3000",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (global.fetch as ReturnType<typeof vi.fn>).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearHooksCache();
  });

  test("should create vanilla listeners for a simple GET route", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: 1, name: "John" }],
    });

    const client = createClientBuilder(clientConfig, testLibraryConfig);
    const clientObj = {
      users: client.createHook("/users"),
    };

    const { users } = useFragno(clientObj);
    const userStore = users();

    // Subscribe to trigger the fetch - this will keep the store active
    const unsubscribe = userStore.subscribe(() => {});

    // Wait for data to load
    await vi.waitFor(() => {
      const state = userStore.get();
      expect(state.loading).toBe(false);
      expect(state.data).toBeDefined();
    });

    const state = userStore.get();
    expect(state.data).toEqual([{ id: 1, name: "John" }]);
    expect(state.error).toBeUndefined();

    unsubscribe();
  });

  test("should support listen and subscribe methods", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: 1, name: "John" }],
    });

    const client = createClientBuilder(clientConfig, testLibraryConfig);
    const clientObj = {
      users: client.createHook("/users"),
    };

    const { users } = useFragno(clientObj);
    const userStore = users();

    const listenCallback = vi.fn();
    const subscribeCallback = vi.fn();

    userStore.listen(listenCallback);
    userStore.subscribe(subscribeCallback);

    // Wait for initial load
    await vi.waitFor(() => {
      const state = userStore.get();
      expect(state.loading).toBe(false);
    });

    expect(listenCallback).toHaveBeenCalled();
    expect(subscribeCallback).toHaveBeenCalled();
  });

  test("should support refetch functionality", async () => {
    let callCount = 0;
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => [{ id: callCount, name: `John${callCount}` }],
      };
    });

    const client = createClientBuilder(clientConfig, testLibraryConfig);
    const clientObj = {
      useUsers: client.createHook("/users"),
    };

    const { useUsers } = useFragno(clientObj);
    const userStore = useUsers();

    const stateAfterInitialLoad = await waitForAsyncIterator(
      userStore,
      (state) => state.loading === false,
    );
    expect(stateAfterInitialLoad).toEqual({
      loading: false,
      data: [{ id: 1, name: "John1" }],
    });

    // Refetch data
    userStore.refetch();

    const stateAfterRefetch = await waitForAsyncIterator(
      userStore,
      (state) => state.loading === false,
    );
    expect(stateAfterRefetch).toEqual({
      loading: false,
      data: [{ id: 2, name: "John2" }],
    });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("should create vanilla listeners with path parameters", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 123, name: "John" }),
    });

    const client = createClientBuilder(clientConfig, testLibraryConfig);
    const clientObj = {
      user: client.createHook("/users/:id"),
    };

    const { user } = useFragno(clientObj);
    const userStore = user({ pathParams: { id: "123" } });

    // Subscribe to trigger the fetch - this will keep the store active
    const unsubscribe = userStore.subscribe(() => {});

    await vi.waitFor(() => {
      const state = userStore.get();
      expect(state.loading).toBe(false);
      expect(state.data).toBeDefined();
    });

    expect(userStore.get().data).toEqual({ id: 123, name: "John" });
    expect(fetch).toHaveBeenCalledWith("http://localhost:3000/api/test-library/users/123");

    unsubscribe();
  });

  test("should create vanilla listeners with query parameters", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ["result1", "result2"],
    });

    const client = createClientBuilder(clientConfig, testLibraryConfig);
    const clientObj = {
      search: client.createHook("/search"),
    };

    const { search } = useFragno(clientObj);
    const searchStore = search({ queryParams: { q: "test" } });

    // Subscribe to trigger the fetch - this will keep the store active
    const unsubscribe = searchStore.subscribe(() => {});

    await vi.waitFor(() => {
      const state = searchStore.get();
      expect(state.loading).toBe(false);
      expect(state.data).toBeDefined();
    });

    expect(searchStore.get().data).toEqual(["result1", "result2"]);
    expect(fetch).toHaveBeenCalledWith("http://localhost:3000/api/test-library/search?q=test");

    unsubscribe();
  });

  test("should support async iteration over hook state changes", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: 1, name: "John" }],
    });

    const client = createClientBuilder(clientConfig, testLibraryConfig);
    const clientObj = {
      users: client.createHook("/users"),
    };

    const { users } = useFragno(clientObj);
    const userStore = users();

    // Subscribe to trigger the fetch - this will keep the store active
    const unsubscribe = userStore.subscribe(() => {});

    // Use waitForAsyncIterator to wait for the loaded state
    const finalState = await waitForAsyncIterator(
      userStore,
      (state) => state.loading === false && state.data !== undefined,
      { timeout: 3000 },
    );

    // Verify final state
    expect(finalState).toEqual({
      loading: false,
      error: undefined,
      data: [{ id: 1, name: "John" }],
    });

    unsubscribe();
  });

  test("should support reactive path parameters with atoms", async () => {
    const idAtom = atom("1");

    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 1, name: "John" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 2, name: "Jane" }),
      });

    const client = createClientBuilder(clientConfig, testLibraryConfig);
    const clientObj = {
      user: client.createHook("/users/:id"),
    };

    const { user } = useFragno(clientObj);
    const userStore = user({ pathParams: { id: idAtom } });

    // Subscribe to trigger the fetch - this will keep the store active
    const unsubscribe = userStore.subscribe(() => {});

    await vi.waitFor(() => {
      const state = userStore.get();
      expect(state.loading).toBe(false);
      expect(state.data).toBeDefined();
    });

    expect(userStore.get().data).toEqual({ id: 1, name: "John" });

    // Update the atom value
    idAtom.set("2");

    await vi.waitFor(() => {
      const state = userStore.get();
      expect(state.data).toEqual({ id: 2, name: "Jane" });
    });

    expect(fetch).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  test("errors then success", async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce("Network error")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 1, name: "John" }),
      });

    const client = createClientBuilder(clientConfig, testLibraryConfig);
    const clientObj = {
      user: client.createHook("/users/:id", {
        onErrorRetry: () => 1, // Wait only 1ms before retrying
      }),
    };

    const { user } = useFragno(clientObj);
    const userStore = user({ pathParams: { id: "123" } });

    const asyncIterator = userStore[Symbol.asyncIterator]();

    // Initial state: store is loading
    {
      const { value } = await asyncIterator.next();
      expect(value).toBeDefined();
      const { data, error, loading } = value!;
      expect(data).toBeUndefined();
      expect(error).toBeUndefined();
      expect(loading).toBe(true);
    }

    // First "result": loading is false, error is now set.
    {
      const { value } = await asyncIterator.next();
      expect(value).toBeDefined();
      const { data, error, loading } = value!;
      expect(data).toBeUndefined();
      expect(error).toBeInstanceOf(FragnoClientFetchNetworkError);
      expect(loading).toBe(false);
    }

    // Retry initiated: loading is true
    {
      const { value } = await asyncIterator.next();
      expect(value).toBeDefined();
      const { data, error, loading } = value!;
      expect(data).toBeUndefined();
      expect(error).toBeUndefined();
      expect(loading).toBe(true);
    }

    // Retry succeeded: data is now available.
    {
      const { value } = await asyncIterator.next();
      expect(value).toBeDefined();
      const { data, error, loading } = value!;
      expect(data).toEqual({ id: 1, name: "John" });
      expect(error).toBeUndefined();
      expect(loading).toBe(false);
    }
    const { done } = await asyncIterator.return();
    expect(done).toBe(true);
  });
});

describe("createVanillaMutator", () => {
  const testLibraryConfig = {
    name: "test-library-mutator",
    routes: [
      addRoute({
        method: "POST",
        path: "/users",
        inputSchema: z.object({ name: z.string(), email: z.string() }),
        outputSchema: z.object({ id: z.number(), name: z.string(), email: z.string() }),
        handler: async (_ctx, { json }) => json({ id: 1, name: "", email: "" }),
      }),
      addRoute({
        method: "PUT",
        path: "/users/:id",
        inputSchema: z.object({ name: z.string() }),
        outputSchema: z.object({ id: z.number(), name: z.string() }),
        handler: async ({ pathParams }, { json }) =>
          json({ id: Number(pathParams["id"]), name: "" }),
      }),
      addRoute({
        method: "DELETE",
        path: "/users/:id",
        inputSchema: z.object({}),
        outputSchema: z.object({ success: z.boolean() }),
        handler: async (_ctx, { json }) => json({ success: true }),
      }),
    ],
  } as const;

  const clientConfig: FragnoPublicClientConfig = {
    baseUrl: "http://localhost:3000",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (global.fetch as ReturnType<typeof vi.fn>).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearHooksCache();
  });

  test("should create a vanilla mutator for POST route", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1, name: "John", email: "john@example.com" }),
    });

    const client = createClientBuilder(clientConfig, testLibraryConfig);
    const clientObj = {
      createUser: client.createMutator("POST", "/users"),
    };

    const { createUser } = useFragno(clientObj);
    const mutator = createUser();

    const result = await mutator.mutate({
      body: { name: "John", email: "john@example.com" },
      params: {},
    });

    expect(result).toEqual({ id: 1, name: "John", email: "john@example.com" });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/users"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "John", email: "john@example.com" }),
      }),
    );
  });

  test("should track loading state during mutation", async () => {
    let resolvePromise: (value: unknown) => void;
    const fetchPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    (global.fetch as ReturnType<typeof vi.fn>).mockReturnValueOnce(fetchPromise);

    const client = createClientBuilder(clientConfig, testLibraryConfig);
    const clientObj = {
      createUser: client.createMutator("POST", "/users"),
    };

    const { createUser } = useFragno(clientObj);
    const mutator = createUser();

    const stateChanges: Array<{ loading?: boolean; data?: unknown }> = [];
    mutator.subscribe((state) => {
      stateChanges.push({ loading: state.loading, data: state.data });
    });

    // Initial state
    expect(mutator.get()).toEqual({ loading: false, error: undefined, data: undefined });

    // Start mutation
    const mutatePromise = mutator.mutate({
      body: { name: "John", email: "john@example.com" },
      params: {},
    });

    // Check loading state
    await vi.waitFor(() => {
      expect(mutator.get().loading).toBe(true);
    });

    // Resolve the fetch
    resolvePromise!({
      ok: true,
      json: async () => ({ id: 1, name: "John", email: "john@example.com" }),
    });

    const result = await mutatePromise;

    // Check final state
    expect(mutator.get()).toEqual({
      loading: false,
      error: undefined,
      data: { id: 1, name: "John", email: "john@example.com" },
    });

    expect(result).toEqual({ id: 1, name: "John", email: "john@example.com" });
  });

  test("should create a vanilla mutator for PUT route with path params", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 123, name: "Jane" }),
    });

    const client = createClientBuilder(clientConfig, testLibraryConfig);
    const clientObj = {
      updateUser: client.createMutator("PUT", "/users/:id"),
    };

    const { updateUser } = useFragno(clientObj);
    const mutator = updateUser();

    const result = await mutator.mutate({
      body: { name: "Jane" },
      params: { pathParams: { id: "123" } },
    });

    expect(result).toEqual({ id: 123, name: "Jane" });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/users/123"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ name: "Jane" }),
      }),
    );
  });

  test("should create a vanilla mutator for DELETE route", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    const client = createClientBuilder(clientConfig, testLibraryConfig);
    const clientObj = {
      deleteUser: client.createMutator("DELETE", "/users/:id"),
    };

    const { deleteUser } = useFragno(clientObj);
    const mutator = deleteUser();

    const result = await mutator.mutate({
      body: {},
      params: { pathParams: { id: "123" } },
    });

    expect(result).toEqual({ success: true });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/users/123"),
      expect.objectContaining({
        method: "DELETE",
      }),
    );
  });

  test("should support subscribe method for mutator state changes", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1, name: "John", email: "john@example.com" }),
    });

    const client = createClientBuilder(clientConfig, testLibraryConfig);
    const clientObj = {
      createUser: client.createMutator("POST", "/users"),
    };

    const { createUser } = useFragno(clientObj);
    const mutator = createUser();

    const stateCallback = vi.fn();
    mutator.subscribe(stateCallback);

    await mutator.mutate({
      body: { name: "John", email: "john@example.com" },
      params: {},
    });

    // Should be called for loading state changes
    expect(stateCallback).toHaveBeenCalled();
  });

  test("should support async iteration over mutator state changes", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1, name: "John", email: "john@example.com" }),
    });

    const client = createClientBuilder(clientConfig, testLibraryConfig);
    const clientObj = {
      createUser: client.createMutator("POST", "/users"),
    };

    const { createUser } = useFragno(clientObj);
    const mutator = createUser();

    // Start the mutation
    const mutatePromise = mutator.mutate({
      body: { name: "John", email: "john@example.com" },
      params: {},
    });

    // Use waitForAsyncIterator to wait for the completed state
    const finalState = await waitForAsyncIterator(
      mutator,
      (state) => state.loading === false && state.data !== undefined,
      { timeout: 3000 },
    );

    // Verify final state
    expect(finalState).toEqual({
      loading: false,
      error: undefined,
      data: { id: 1, name: "John", email: "john@example.com" },
    });

    // Ensure mutation completes
    const result = await mutatePromise;
    expect(result).toEqual({ id: 1, name: "John", email: "john@example.com" });
  });
});

describe("useFragno", () => {
  const testLibraryConfig = {
    name: "test-library-useFragno",
    routes: [
      addRoute({
        method: "GET",
        path: "/data",
        outputSchema: z.string(),
        handler: async (_ctx, { json }) => json("test data"),
      }),
      addRoute({
        method: "POST",
        path: "/action",
        inputSchema: z.object({ value: z.string() }),
        outputSchema: z.object({ result: z.string() }),
        handler: async (_ctx, { json }) => json({ result: "test value" }),
      }),
    ],
  } as const;

  const clientConfig: FragnoPublicClientConfig = {
    baseUrl: "http://localhost:3000",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (global.fetch as ReturnType<typeof vi.fn>).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearHooksCache();
  });

  test("should transform a mixed object of hooks and mutators", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => "test data",
    });

    const client = createClientBuilder(clientConfig, testLibraryConfig);
    const clientObj = {
      data: client.createHook("/data"),
      postAction: client.createMutator("POST", "/action"),
    };

    const { data, postAction } = useFragno(clientObj);

    // Test the hook
    const dataStore = data();

    // Subscribe to trigger the fetch - this will keep the store active
    const unsubscribe = dataStore.subscribe(() => {});

    await vi.waitFor(() => {
      const state = dataStore.get();
      expect(state.loading).toBe(false);
      expect(state.data).toBeDefined();
    });

    expect(dataStore.get().data).toBe("test data");

    // Test the mutator
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: "test value" }),
    });

    const mutator = postAction();
    const mutatorResult = await mutator.mutate({
      body: { value: "test value" },
      params: {},
    });

    expect(mutatorResult).toEqual({ result: "test value" });

    unsubscribe();
  });

  test("should throw error for invalid hook types", () => {
    const invalidHook = {
      route: { method: "INVALID" as never, path: "/test" },
    };

    const clientObj = {
      invalid: invalidHook as never,
    };

    expect(() => useFragno(clientObj)).toThrow(
      "Hook invalid doesn't match either GET or mutator type guard",
    );
  });

  test("multiple GET hooks for the same path should share the same store", async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => "data1",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => "data2",
      });

    const client = createClientBuilder(clientConfig, testLibraryConfig);
    const clientObj = {
      data1: client.createHook("/data"),
      data2: client.createHook("/data"),
    };

    const { data1, data2 } = useFragno(clientObj);

    const store1 = data1();
    const store2 = data2();

    // Subscribe to trigger the fetches - this will keep the stores active
    const unsubscribe1 = store1.subscribe(() => {});
    const unsubscribe2 = store2.subscribe(() => {});

    await vi.waitFor(() => {
      expect(store1.get().loading).toBe(false);
      expect(store2.get().loading).toBe(false);
      expect(store1.get().data).toBeDefined();
      expect(store2.get().data).toBeDefined();
    });

    expect(fetch).toHaveBeenCalledTimes(1);

    expect(store1.get().data).toBe("data1");
    expect(store2.get().data).toBe("data1");

    unsubscribe1();
    unsubscribe2();
  });
});

describe("error handling", () => {
  const testLibraryConfig = {
    name: "test-library-errors",
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
        inputSchema: z.object({ name: z.string(), email: z.string() }),
        outputSchema: z.object({ id: z.number(), name: z.string(), email: z.string() }),
        handler: async (_ctx, { json }) => json({ id: 1, name: "", email: "" }),
      }),
    ],
  } as const;

  const clientConfig: FragnoPublicClientConfig = {
    baseUrl: "http://localhost:3000",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (global.fetch as ReturnType<typeof vi.fn>).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearHooksCache();
  });

  test("should handle GET hook errors gracefully", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Network error"));

    const client = createClientBuilder(clientConfig, testLibraryConfig);
    const clientObj = {
      users: client.createHook("/users", {
        onErrorRetry: null,
      }),
    };

    const { users } = useFragno(clientObj);
    const userStore = users();

    const asyncIterator = userStore[Symbol.asyncIterator]();

    {
      const { value } = await asyncIterator.next();
      expect(value).toBeDefined();
      const { data, error, loading } = value!;
      expect(data).toBeUndefined();
      expect(error).toBeUndefined();
      expect(loading).toBe(true);
    }

    {
      const { value } = await asyncIterator.next();
      expect(value).toBeDefined();
      const { data, error, loading } = value!;
      expect(data).toBeUndefined();
      expect(error).toBeInstanceOf(FragnoClientFetchNetworkError);
      expect(loading).toBe(false);
    }

    await asyncIterator.return();
  });

  test("should handle mutator errors gracefully", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Server error"));

    const client = createClientBuilder(clientConfig, testLibraryConfig);
    const clientObj = {
      createUser: client.createMutator("POST", "/users"),
    };

    const { createUser } = useFragno(clientObj);
    const mutator = createUser();

    mutator.mutate({
      body: { name: "John", email: "john@example.com" },
      params: {},
    });

    const finalState = await waitForAsyncIterator(
      mutator,
      (state) => state.error !== undefined && state.loading === false,
    );

    expect(finalState).toEqual({
      loading: false,
      error: expect.any(FragnoClientFetchNetworkError),
      data: undefined,
    });
  });
});
