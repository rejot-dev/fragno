import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { atom, computed } from "nanostores";
import { z } from "zod";
import { createClientBuilder } from "./client";
import { useFragno, useStore } from "./react";
import { addRoute } from "../api/api";
import type { FragnoPublicClientConfig } from "../mod";
import { FragnoClientFetchNetworkError } from "./client-error";

// Mock fetch globally
global.fetch = vi.fn();

describe("createReactHook", () => {
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
  });

  test("should create a hook for a simple GET route", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      headers: new Headers(),
      ok: true,
      json: async () => [{ id: 1, name: "John" }],
    });

    const client = createClientBuilder(clientConfig, testLibraryConfig);
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

    const client = createClientBuilder(clientConfig, testLibraryConfig);
    const clientObj = {
      user: client.createHook("/users/:id"),
    };

    const { user } = useFragno(clientObj);
    const { result } = renderHook(() => user({ id: "123" }));

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

    const client = createClientBuilder(clientConfig, testLibraryConfig);
    const clientObj = {
      search: client.createHook("/search"),
    };

    const { search } = useFragno(clientObj);
    const { result } = renderHook(() => search(undefined, { q: "test" }));

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

    const client = createClientBuilder(clientConfig, testLibraryConfig);
    const clientObj = {
      user: client.createHook("/users/:id"),
    };

    const { user } = useFragno(clientObj);
    const { result } = renderHook(() => user({ id: idAtom }));

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

    const client = createClientBuilder(clientConfig, testLibraryConfig);
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
  const testLibraryConfig = {
    name: "test-library",
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
    ],
  } as const;

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

    const _route1 = testLibraryConfig.routes[0];
    type _Route1 = typeof _route1;

    const client = createClientBuilder(clientConfig, testLibraryConfig);
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

    const client = createClientBuilder(clientConfig, testLibraryConfig);
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

    const client = createClientBuilder(clientConfig, testLibraryConfig);
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
    const testLocalLibraryConfig = {
      name: "test-library",
      routes: [
        addRoute({
          method: "DELETE",
          path: "/users/:id",
          inputSchema: z.object({}),
          outputSchema: z.object({ success: z.boolean() }),
          handler: async (_ctx, { json }) => json({ success: true }),
        }),
      ],
    } as const;

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      headers: new Headers(),
      ok: true,
      json: async () => ({ success: true }),
    });

    const client = createClientBuilder(clientConfig, testLocalLibraryConfig);
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
    const testLocalLibraryConfig = {
      name: "test-library",
      routes: [
        addRoute({
          method: "DELETE",
          path: "/users/:id",
          handler: async (_ctx, { empty }) => empty(),
        }),
      ],
    } as const;

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      headers: new Headers(),
      ok: true,
      status: 204,
    });

    const client = createClientBuilder(clientConfig, testLocalLibraryConfig);
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

    const client = createClientBuilder(clientConfig, testLibraryConfig);
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
  const testLibraryConfig = {
    name: "test-library",
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

  test("should transform a mixed object of hooks and mutators", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      headers: new Headers(),
      ok: true,
      json: async () => "test data",
    });

    const client = createClientBuilder(clientConfig, testLibraryConfig);
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
