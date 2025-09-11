import { test, expect, describe, vi, beforeEach, afterEach, expectTypeOf } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { atom, computed } from "nanostores";
import { z } from "zod";
import { createClientBuilder } from "./client";
import { useFragno, useStore } from "./react";
import { defineRoute } from "../api/route";
import { defineLibrary } from "../api/library";
import type { FragnoPublicClientConfig } from "../mod";
import { FragnoClientFetchNetworkError } from "./client-error";

// Mock fetch globally
global.fetch = vi.fn();

describe("createReactHook", () => {
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
      path: "/users/:id",
      outputSchema: z.object({ id: z.number(), name: z.string() }),
      handler: async ({ pathParams }, { json }) =>
        json({ id: Number(pathParams["id"]), name: "John" }),
    }),
    defineRoute({
      method: "GET",
      path: "/search",
      outputSchema: z.array(z.string()),
      handler: async (_ctx, { json }) => json(["result1", "result2"]),
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

  test("should create a hook for a simple GET route", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      headers: new Headers(),
      ok: true,
      json: async () => [{ id: 1, name: "John" }],
    });

    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      users: client.createHook("/users"),
    };

    const { users } = useFragno(clientObj);
    const { result } = renderHook(() => users());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual([{ id: 1, name: "John" }]);
    expect(result.current.error).toBeUndefined();
  });

  test("should create a hook with path parameters", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      headers: new Headers(),
      ok: true,
      json: async () => ({ id: 123, name: "John" }),
    });

    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      user: client.createHook("/users/:id"),
    };

    const { user } = useFragno(clientObj);
    const { result } = renderHook(() => user({ path: { id: "123" } }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual({ id: 123, name: "John" });
    expect(fetch).toHaveBeenCalledWith("http://localhost:3000/api/test-library/users/123");
  });

  test("should create a hook with query parameters", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      headers: new Headers(),
      ok: true,
      json: async () => ["result1", "result2"],
    });

    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      search: client.createHook("/search"),
    };

    const { search } = useFragno(clientObj);
    const { result } = renderHook(() => search({ query: { q: "test" } }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual(["result1", "result2"]);
    expect(fetch).toHaveBeenCalledWith("http://localhost:3000/api/test-library/search?q=test");
  });

  test("should support reactive path parameters with atoms", async () => {
    const idAtom = atom("1");

    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        headers: new Headers(),
        ok: true,
        json: async () => ({ id: 1, name: "John" }),
      })
      .mockResolvedValueOnce({
        headers: new Headers(),
        ok: true,
        json: async () => ({ id: 2, name: "Jane" }),
      });

    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      user: client.createHook("/users/:id"),
    };

    const { user } = useFragno(clientObj);
    const { result } = renderHook(() => user({ path: { id: idAtom } }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual({ id: 1, name: "John" });

    // Update the atom value
    act(() => {
      idAtom.set("2");
    });

    await waitFor(() => {
      expect(result.current.data).toEqual({ id: 2, name: "Jane" });
    });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("should handle errors gracefully", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Network error"));

    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      useUsers: client.createHook("/users"),
    };

    const { useUsers } = useFragno(clientObj);
    const { result } = renderHook(() => useUsers());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBeInstanceOf(FragnoClientFetchNetworkError);
    expect(result.current.data).toBeUndefined();
  });
});

describe("createReactMutator", () => {
  const testLibraryDefinition = defineLibrary("test-library");
  const testRoutes = [
    defineRoute({
      method: "POST",
      path: "/users",
      inputSchema: z.object({ name: z.string(), email: z.string() }),
      outputSchema: z.object({ id: z.number(), name: z.string(), email: z.string() }),
      handler: async (_ctx, { json }) => json({ id: 1, name: "", email: "" }),
    }),
    defineRoute({
      method: "PUT",
      path: "/users/:id",
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ id: z.number(), name: z.string() }),
      handler: async ({ pathParams }, { json }) => json({ id: Number(pathParams["id"]), name: "" }),
    }),
  ] as const;

  const clientConfig: FragnoPublicClientConfig = {
    baseUrl: "http://localhost:3000",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (global.fetch as ReturnType<typeof vi.fn>).mockReset();
  });

  test("should be able to use mutator for POST route - direct result", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      headers: new Headers(),
      ok: true,
      json: async () => ({ id: 1, name: "John", email: "john@example.com" }),
    });

    const _route1 = testRoutes[0];
    type _Route1 = typeof _route1;

    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      useCreateUserMutator: client.createMutator("POST", "/users"),
    };

    const { useCreateUserMutator } = useFragno(clientObj);
    const { result: renderedHook } = renderHook(() => useCreateUserMutator());
    const { mutate: createUser } = renderedHook.current;

    const result = await createUser({
      body: { name: "John", email: "john@example.com" },
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

  test("should be able to use mutator for POST route - result in store", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      headers: new Headers(),
      ok: true,
      json: async () => ({ id: 1, name: "John", email: "john@example.com" }),
    });

    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      useCreateUserMutator: client.createMutator("POST", "/users"),
    };

    const { useCreateUserMutator } = useFragno(clientObj);
    const { result: renderedHook } = renderHook(() => useCreateUserMutator());
    const { mutate: createUser } = renderedHook.current;

    await createUser({
      body: { name: "John", email: "john@example.com" },
    });

    await waitFor(() => {
      expect(renderedHook.current.loading).toBe(false);
    });

    expect(renderedHook.current.data).toEqual({ id: 1, name: "John", email: "john@example.com" });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/users"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "John", email: "john@example.com" }),
      }),
    );
  });

  test("should create a mutator for PUT route with path params", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      headers: new Headers(),
      ok: true,
      json: async () => ({ id: 123, name: "Jane" }),
    });

    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      useUpdateUserMutator: client.createMutator("PUT", "/users/:id"),
    };

    const { useUpdateUserMutator } = useFragno(clientObj);
    const { result: renderedHook } = renderHook(() => useUpdateUserMutator());
    const { mutate: updateUser } = renderedHook.current;

    const result = await updateUser({
      body: { name: "Jane" },
      path: { id: "123" },
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

  test("should create a mutator for DELETE route (with inputSchema and outputSchema)", async () => {
    const testLocalLibraryDefinition = defineLibrary("test-library");
    const testLocalRoutes = [
      defineRoute({
        method: "DELETE",
        path: "/users/:id",
        inputSchema: z.object({}),
        outputSchema: z.object({ success: z.boolean() }),
        handler: async (_ctx, { json }) => json({ success: true }),
      }),
    ] as const;

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      headers: new Headers(),
      ok: true,
      json: async () => ({ success: true }),
    });

    const client = createClientBuilder(testLocalLibraryDefinition, clientConfig, testLocalRoutes);
    const clientObj = {
      useDeleteUserMutator: client.createMutator("DELETE", "/users/:id"),
    };

    const { useDeleteUserMutator } = useFragno(clientObj);
    const { result: renderedHook } = renderHook(() => useDeleteUserMutator());
    const hook = renderedHook.current;

    const result = await hook.mutate({
      body: {},
      path: { id: "123" },
    });

    expect(result).toEqual({ success: true });

    await waitFor(() => {
      expect(hook.loading).toBe(false);
    });

    expect(hook).toEqual({
      loading: false,
      // TODO: Error and data should be in here, right?
      // error: undefined,
      // data: { success: true },
      mutate: expect.any(Function),
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/users/123"),
      expect.objectContaining({
        method: "DELETE",
      }),
    );
  });

  test("should create a mutator for DELETE route (withOUT inputSchema and outputSchema)", async () => {
    const testLocalLibraryDefinition = defineLibrary("test-library");
    const testLocalRoutes = [
      defineRoute({
        method: "DELETE",
        path: "/users/:id",
        handler: async (_ctx, { empty }) => empty(),
      }),
    ] as const;

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      headers: new Headers(),
      ok: true,
      status: 204,
    });

    const client = createClientBuilder(testLocalLibraryDefinition, clientConfig, testLocalRoutes);
    const clientObj = {
      useDeleteUserMutator: client.createMutator("DELETE", "/users/:id"),
    };

    const { useDeleteUserMutator } = useFragno(clientObj);
    const { result: renderedHook } = renderHook(() => useDeleteUserMutator());
    const hook = renderedHook.current;

    const result = await hook.mutate({
      path: { id: "123" },
    });

    expect(result).toBeUndefined();

    await waitFor(() => {
      expect(hook.loading).toBe(false);
    });

    expect(hook).toEqual({
      loading: false,
      // TODO: Error and data should be in here, right?
      // error: undefined,
      // data: { success: true },
      mutate: expect.any(Function),
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/users/123"),
      expect.objectContaining({
        method: "DELETE",
      }),
    );
  });

  test("should handle mutation errors", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Server error"));

    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      useCreateUserMutator: client.createMutator("POST", "/users"),
    };

    const { useCreateUserMutator } = useFragno(clientObj);
    const { result: renderedHook } = renderHook(() => useCreateUserMutator());
    const { mutate: createUser } = renderedHook.current;

    await expect(
      createUser({
        body: { name: "John", email: "john@example.com" },
      }),
    );

    await waitFor(() => {
      expect(renderedHook.current.loading).toBe(false);
    });

    expect(renderedHook.current.error).toBeInstanceOf(FragnoClientFetchNetworkError);
  });
});

describe("useFragno", () => {
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

  const clientConfig: FragnoPublicClientConfig = {
    baseUrl: "http://localhost:3000",
  };

  test("should transform a mixed object of hooks and mutators", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      headers: new Headers(),
      ok: true,
      json: async () => "test data",
    });

    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      useData: client.createHook("/data"),
      usePostAction: client.createMutator("POST", "/action"),
    };

    const { useData, usePostAction } = useFragno(clientObj);

    const { result: renderedHook } = renderHook(() => usePostAction());
    const { mutate: postAction } = renderedHook.current;

    // Test the hook
    const { result: hookResult } = renderHook(() => useData());

    await waitFor(() => {
      expect(hookResult.current.loading).toBe(false);
    });

    expect(hookResult.current.data).toBe("test data");

    // Test the mutator
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      headers: new Headers(),
      ok: true,
      json: async () => ({ result: "test value" }),
    });

    const mutatorResult = await postAction({
      body: { value: "test value" },
    });
    expect(mutatorResult).toEqual({ result: "test value" });
  });

  test("should pass through non-hook values unchanged", () => {
    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      useData: client.createHook("/data"),
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

    // Verify that the hook is still transformed
    expect(typeof result.useData).toBe("function");
  });

  test("should preserve reference equality for non-hook objects", () => {
    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const sharedObject = { shared: true };
    const sharedArray = [1, 2, 3];
    const sharedFunction = () => "shared";

    const clientObj = {
      useData: client.createHook("/data"),
      obj: sharedObject,
      arr: sharedArray,
      fn: sharedFunction,
    };

    const result = useFragno(clientObj);

    // Check that references are preserved
    expect(result.obj).toBe(sharedObject);
    expect(result.arr).toBe(sharedArray);
    expect(result.fn).toBe(sharedFunction);
  });

  test("should handle mixed object with hooks, mutators, and other values", () => {
    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      // Hooks and mutators
      useData: client.createHook("/data"),
      usePostAction: client.createMutator("POST", "/action"),
      // Regular values
      config: { apiKey: "test-key", timeout: 5000 },
      utils: {
        formatDate: (date: Date) => date.toISOString(),
        parseId: (id: string) => parseInt(id, 10),
      },
      constants: {
        MAX_RETRIES: 3,
        DEFAULT_PAGE_SIZE: 20,
      },
      metadata: {
        version: "1.0.0",
        environment: "test",
      },
    };

    const result = useFragno(clientObj);

    // Check hooks are transformed
    expect(typeof result.useData).toBe("function");
    expect(typeof result.usePostAction).toBe("function");

    // Check other values are passed through
    expect(result.config).toEqual({ apiKey: "test-key", timeout: 5000 });
    expect(result.utils.formatDate(new Date("2024-01-01"))).toBe("2024-01-01T00:00:00.000Z");
    expect(result.utils.parseId("123")).toBe(123);
    expect(result.constants.MAX_RETRIES).toBe(3);
    expect(result.constants.DEFAULT_PAGE_SIZE).toBe(20);
    expect(result.metadata).toEqual({ version: "1.0.0", environment: "test" });

    expectTypeOf<(typeof result)["config"]>().toEqualTypeOf<{ apiKey: string; timeout: number }>();
    expectTypeOf<(typeof result)["utils"]>().toEqualTypeOf<{
      formatDate: (date: Date) => string;
      parseId: (id: string) => number;
    }>();
    expectTypeOf<(typeof result)["constants"]>().toEqualTypeOf<{
      MAX_RETRIES: number;
      DEFAULT_PAGE_SIZE: number;
    }>();
    expectTypeOf<(typeof result)["metadata"]>().toEqualTypeOf<{
      version: string;
      environment: string;
    }>();
  });

  test("should handle empty object", () => {
    const clientObj = {};
    const result = useFragno(clientObj);
    expect(result).toEqual({});
  });

  test("should handle object with only non-hook values", () => {
    const clientObj = {
      a: 1,
      b: "two",
      c: { three: 3 },
      d: [4, 5, 6],
    };

    const result = useFragno(clientObj);

    expect(result).toEqual(clientObj);
    expect(result.a).toBe(1);
    expect(result.b).toBe("two");
    expect(result.c).toEqual({ three: 3 });
    expect(result.d).toEqual([4, 5, 6]);
  });
});

describe("useStore", () => {
  test("should subscribe to store changes", async () => {
    const store = atom({ count: 0 });

    const { result } = renderHook(() => useStore(store));

    expect(result.current).toEqual({ count: 0 });

    act(() => {
      store.set({ count: 1 });
    });

    expect(result.current).toEqual({ count: 1 });
  });

  test("should handle computed stores", async () => {
    const baseStore = atom(5);
    const doubledStore = computed(baseStore, (value) => value * 2);

    const { result } = renderHook(() => useStore(doubledStore));

    expect(result.current).toBe(10);

    act(() => {
      baseStore.set(7);
    });

    expect(result.current).toBe(14);
  });

  test("should unsubscribe on unmount", () => {
    const store = atom({ value: 0 });
    const unsubscribeSpy = vi.fn();

    // Mock the store.listen method to track unsubscribe
    const originalListen = store.listen;
    store.listen = vi.fn((callback) => {
      const unsubscribe = originalListen.call(store, callback);
      return () => {
        unsubscribeSpy();
        unsubscribe();
      };
    });

    const { unmount } = renderHook(() => useStore(store));

    expect(store.listen).toHaveBeenCalled();

    unmount();

    expect(unsubscribeSpy).toHaveBeenCalled();
  });
});
