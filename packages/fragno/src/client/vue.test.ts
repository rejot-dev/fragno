import { test, expect, describe, vi, beforeEach, afterEach, assert, expectTypeOf } from "vitest";
import { type FragnoPublicClientConfig } from "./client";
import { createClientBuilder } from "./client";
import { defineRoute } from "../api/route";
import { defineFragment } from "../api/fragment-definition-builder";
import { z } from "zod";
import { refToAtom, useFragno } from "./vue";
import { waitFor } from "@testing-library/vue";
import { nextTick, ref, watch } from "vue";
import { FragnoClientUnknownApiError } from "./client-error";
import { atom, computed } from "nanostores";

global.fetch = vi.fn();

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

    // Type assertions to ensure types are correctly inferred
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
    const store = useStore();
    expect(store.message.value).toBe("hello");
    expect(store.count.value).toBe(42);
    expect(store.isActive.value).toBe(true);
    expect(store.data.value).toEqual({ count: 0 });
    expect(store.items.value).toEqual(["a", "b", "c"]);
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
    const store = useComputedValues();
    expect(store.base.value).toBe(10);
    expect(store.doubled.value).toBe(20);
    expect(store.tripled.value).toBe(30);
    expect(store.combined.value).toEqual({ doubled: 20, tripled: 30 });
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
    const store = useMixed();
    expect(store.message.value).toBe("test");
    expect(store.multiply(5)).toBe(10);
    expect(store.config).toEqual({ foo: "bar", baz: 123 });
    expect(store.constant).toBe(42);
  });

  test("FragnoVueStore type test - single store vs object with stores", () => {
    // Test that a single store is unwrapped directly
    const singleAtom: ReadableAtom<string> = atom("single");
    const cb = createClientBuilder(defineFragment("test-fragment"), clientConfig, []);

    // Single store case
    const clientSingle = {
      useSingle: cb.createStore(singleAtom),
    };

    // Object with stores case
    const clientObject = {
      useObject: cb.createStore({
        value: singleAtom,
      }),
    };

    const { useSingle } = useFragno(clientSingle);
    const { useObject } = useFragno(clientObject);

    // Type assertions
    expectTypeOf(useSingle).toExtend<() => string>();
    expectTypeOf(useObject).toExtend<() => { value: string }>();

    // Runtime test
    const singleStore = useSingle();
    expect(singleStore()).toBe("single");

    const objectStore = useObject();
    expect(objectStore()).toEqual({ value: "single" });
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
    const store = useAppState();
    expect(store.user.value).toEqual({ id: 1, name: "John", email: "john@example.com" });
    expect(store.settings.value).toEqual({ theme: "light", notifications: true });
    expect(store.loading.value).toBe(false);
    expect(store.error.value).toBeNull();
  });

  test("should handle reactive updates to atoms", async () => {
    const countAtom = atom(0);
    const messageAtom = atom("initial");

    const cb = createClientBuilder(defineFragment("test-fragment"), clientConfig, []);
    const client = {
      useStore: cb.createStore({
        count: countAtom,
        message: messageAtom,
      }),
    };

    const { useStore } = useFragno(client);
    const store = useStore();

    // Initial values
    expect(store.count.value).toBe(0);
    expect(store.message.value).toBe("initial");

    // Update atoms
    countAtom.set(5);
    messageAtom.set("updated");

    await waitFor(() => {
      expect(store.count.value).toBe(5);
      expect(store.message.value).toBe("updated");
    });
  });

  test("should handle computed atoms with dependencies", async () => {
    const baseAtom = atom(10);
    const doubled = computed(baseAtom, (n) => n * 2);

    const cb = createClientBuilder(defineFragment("test-fragment"), clientConfig, []);
    const client = {
      useComputed: cb.createStore({
        base: baseAtom,
        doubled: doubled,
      }),
    };

    const { useComputed } = useFragno(client);
    const store = useComputed();

    // Initial values
    expect(store.base.value).toBe(10);
    expect(store.doubled.value).toBe(20);

    // Update base atom
    baseAtom.set(5);

    await waitFor(() => {
      expect(store.base.value).toBe(5);
      expect(store.doubled.value).toBe(10);
    });
  });

  test("should work with existing hooks and stores", () => {
    const testFragmentDefinition = defineFragment("test-fragment");
    const testRoutes = [
      defineRoute({
        method: "GET",
        path: "/data",
        outputSchema: z.string(),
        handler: async (_ctx, { json }) => json("test data"),
      }),
    ] as const;

    const counterAtom = atom(0);
    const cb = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
    const client = {
      useData: cb.createHook("/data"),
      useCounter: cb.createStore({
        count: counterAtom,
        increment: () => counterAtom.set(counterAtom.get() + 1),
      }),
      someString: "hello world",
      someNumber: 42,
      someObject: { foo: "bar", nested: { value: true } },
      someArray: [1, 2, 3],
      someFunction: () => "test",
      someNull: null,
      someUndefined: undefined,
    };

    const { useData, useCounter, someString, someNumber, someObject, someArray, someFunction, someNull, someUndefined } = useFragno(client);

    // Verify types
    expectTypeOf(useData).toExtend<(...args: any[]) => any>();
    expectTypeOf(useCounter).toExtend<() => { count: number; increment: () => void }>();
    expectTypeOf(someString).toBeString();
    expectTypeOf(someNumber).toBeNumber();
    expectTypeOf(someObject).toExtend<{ foo: string; nested: { value: boolean } }>();
    expectTypeOf(someArray).toExtend<number[]>();
    expectTypeOf(someFunction).toBeFunction();
    expectTypeOf(someNull).toBeNull();
    expectTypeOf(someUndefined).toBeUndefined();

    // Verify values
    expect(someString).toBe("hello world");
    expect(someNumber).toBe(42);
    expect(someObject).toEqual({ foo: "bar", nested: { value: true } });
    expect(someArray).toEqual([1, 2, 3]);
    expect(someFunction()).toBe("test");
    expect(someNull).toBeNull();
    expect(someUndefined).toBeUndefined();

    // Verify that hooks are still transformed
    expect(typeof useData).toBe("function");
    expect(typeof useCounter).toBe("function");
  });
});