import { test, expect, describe, vi, beforeEach, afterEach, expectTypeOf } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { atom, computed, type ReadableAtom } from "nanostores";
import { z } from "zod";
import { createClientBuilder } from "./client";
import { useFragno, useStore, type FragnoReactStore } from "./react";
import { defineRoute } from "../api/route";
import { defineFragment } from "../api/fragment-definition-builder";
import type { FragnoPublicClientConfig } from "../mod";
import { FragnoClientFetchNetworkError, type FragnoClientError } from "./client-error";
import { RequestOutputContext } from "../api/request-output-context";
import type { FetcherStore } from "@nanostores/query";

// Mock fetch globally
global.fetch = vi.fn();

describe("createReactHook", () => {
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

    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
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

    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
    const clientObj = {
      user: client.createHook("/users/:id"),
    };

    const { user } = useFragno(clientObj);
    const { result } = renderHook(() => user({ path: { id: "123" } }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual({ id: 123, name: "John" });
    expect(fetch).toHaveBeenCalledWith("http://localhost:3000/api/test-fragment/users/123");
  });

  test("should create a hook with query parameters", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      headers: new Headers(),
      ok: true,
      json: async () => ["result1", "result2"],
    });

    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
    const clientObj = {
      search: client.createHook("/search"),
    };

    const { search } = useFragno(clientObj);
    const { result } = renderHook(() => search({ query: { q: "test" } }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual(["result1", "result2"]);
    expect(fetch).toHaveBeenCalledWith("http://localhost:3000/api/test-fragment/search?q=test");
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

    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
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

    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
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
  const testFragmentDefinition = defineFragment("test-fragment");
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

    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
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

    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
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

    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
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
    const testLocalFragmentDefinition = defineFragment("test-fragment");
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

    const client = createClientBuilder(testLocalFragmentDefinition, clientConfig, testLocalRoutes);
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
    const testLocalFragmentDefinition = defineFragment("test-fragment");
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

    const client = createClientBuilder(testLocalFragmentDefinition, clientConfig, testLocalRoutes);
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

    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
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

  const clientConfig: FragnoPublicClientConfig = {
    baseUrl: "http://localhost:3000",
  };

  test("should transform a mixed object of hooks and mutators", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      headers: new Headers(),
      ok: true,
      json: async () => "test data",
    });

    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
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
    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
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
    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
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
    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
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

  test("FragnoReactStore type test - ReadableAtom fields", () => {
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

    // Runtime test
    const { result } = renderHook(() => useStore());
    expect(result.current.message).toBe("hello");
    expect(result.current.count).toBe(42);
    expect(result.current.isActive).toBe(true);
    expect(result.current.data).toEqual({ count: 0 });
    expect(result.current.items).toEqual(["a", "b", "c"]);
  });

  test("FragnoReactStore type test - computed stores", () => {
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
    const { result } = renderHook(() => useComputedValues());
    expect(result.current.base).toBe(10);
    expect(result.current.doubled).toBe(20);
    expect(result.current.tripled).toBe(30);
    expect(result.current.combined).toEqual({ doubled: 20, tripled: 30 });
  });

  test("FragnoReactStore type test - mixed store and non-store fields", () => {
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
    const { result } = renderHook(() => useMixed());
    expect(result.current.message).toBe("test");
    expect(result.current.multiply(5)).toBe(10);
    expect(result.current.config).toEqual({ foo: "bar", baz: 123 });
    expect(result.current.constant).toBe(42);
  });

  test("FragnoReactStore type test - single store vs object with stores", () => {
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
    const { result: singleResult } = renderHook(() => useSingle());
    expect(singleResult.current).toBe("single");

    const { result: objectResult } = renderHook(() => useObject());
    expect(objectResult.current).toEqual({ value: "single" });
  });

  test("FragnoReactStore type test - complex nested atoms", () => {
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
    const { result } = renderHook(() => useAppState());
    expect(result.current.user).toEqual({ id: 1, name: "John", email: "john@example.com" });
    expect(result.current.settings).toEqual({ theme: "light", notifications: true });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("Derived from streaming route", async () => {
    const streamFragmentDefinition = defineFragment("stream-fragment");
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
    const cb = createClientBuilder(streamFragmentDefinition, clientConfig, streamRoutes);
    const usersStream = cb.createHook("/users-stream");

    // Create a single shared store instance
    const sharedStore = usersStream.store({});

    const names = computed(sharedStore, ({ data }) => {
      return (data ?? []).map((user) => user.name).join(", ");
    });

    const client = {
      useUsersStream: cb.createStore(sharedStore),
      useNames: cb.createStore(names),
    };

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

    const { useNames, useUsersStream } = useFragno(client);

    expectTypeOf(useUsersStream).toEqualTypeOf<
      FragnoReactStore<
        FetcherStore<
          {
            id: number;
            name: string;
          }[],
          FragnoClientError<string>
        >
      >
    >();

    expectTypeOf(useNames).toEqualTypeOf<FragnoReactStore<ReadableAtom<string>>>();

    const { result } = renderHook(() => ({
      usersStream: useUsersStream(),
      names: useNames(),
    }));

    await waitFor(() => {
      expect(result.current.names).toEqual("John, Jane, Jim");
      expect(result.current.usersStream.loading).toBe(false);
      expect(result.current.usersStream.data).toEqual([
        { id: 1, name: "John" },
        { id: 2, name: "Jane" },
        { id: 3, name: "Jim" },
      ]);
    });
  });
});
