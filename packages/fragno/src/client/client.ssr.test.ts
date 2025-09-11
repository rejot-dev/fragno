/**
 * Our tests run with happy-dom by default, this defines `window` making it so that we `fetch()`
 * instead of calling handlers directly. In this file we override it to be "node", so that `window`
 * is not defined.
 *
 * @vitest-environment node
 */

import { assert, describe, expect, test } from "vitest";
import { type FragnoPublicClientConfig } from "../mod";
import { createClientBuilder } from "./client";
import { defineRoute } from "../api/route";
import { defineLibrary } from "../api/library";
import { z } from "zod";
import { createAsyncIteratorFromCallback, waitForAsyncIterator } from "../util/async";
import { FragnoClientUnknownApiError } from "./client-error";

describe("server side rendering", () => {
  const testLibraryDefinition = defineLibrary("test-library");
  const testRoutes = [
    defineRoute({
      method: "GET",
      path: "/users",
      outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
      handler: async (_ctx, { json }) => json([{ id: 1, name: "John" }]),
    }),
  ] as const;

  const clientConfig: FragnoPublicClientConfig = {
    baseUrl: "http://localhost:3000",
  };

  describe("pre-conditions", () => {
    test("Make sure window is undefined", () => {
      expect(typeof window).toBe("undefined");
    });
  });

  test("should call the handler directly", async () => {
    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      useUsers: client.createHook("/users"),
    };

    const { useUsers } = clientObj;

    const data = await useUsers.query({});

    expect(data).toEqual([{ id: 1, name: "John" }]);
  });

  test("should be able to use the store server side", async () => {
    const client = createClientBuilder(testLibraryDefinition, clientConfig, testRoutes);
    const clientObj = {
      useUsers: client.createHook("/users"),
    };

    const { useUsers } = clientObj;
    const userStore = useUsers.store({});

    const result = await waitForAsyncIterator(
      createAsyncIteratorFromCallback(userStore.listen),
      (value) => value.data !== undefined,
    );

    expect(result.data).toEqual([{ id: 1, name: "John" }]);
  });

  test("should be able to stream data server side", async () => {
    const streamLibraryDefinition = defineLibrary("stream-library");
    const streamRoutes = [
      defineRoute({
        method: "GET",
        path: "/users-stream",
        outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
        handler: async (_ctx, { jsonStream }) => {
          return jsonStream(async (stream) => {
            await stream.write({ id: 1, name: "John" });
            await stream.sleep(1);
            await stream.write({ id: 2, name: "Jane" });
            await stream.sleep(1);
            await stream.write({ id: 3, name: "Jim" });
          });
        },
      }),
    ] as const;
    const client = createClientBuilder(streamLibraryDefinition, clientConfig, streamRoutes);
    const clientObj = {
      useUsersStream: client.createHook("/users-stream"),
    };

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
    const streamErrorLibraryDefinition = defineLibrary("stream-error-library");
    const streamErrorRoutes = [
      defineRoute({
        method: "GET",
        path: "/users-stream-error",
        outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
        handler: async (_ctx, { jsonStream }) => {
          return jsonStream(async (stream) => {
            await stream.writeRaw("this is not json lol");
          });
        },
      }),
    ] as const;

    const client = createClientBuilder(
      streamErrorLibraryDefinition,
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
    const streamErrorLibraryDefinition = defineLibrary("stream-error-library");
    const streamErrorRoutes = [
      defineRoute({
        method: "GET",
        path: "/users-stream-error",
        outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
        handler: async (_ctx, { jsonStream }) => {
          return jsonStream(async (stream) => {
            await stream.writeRaw("\n\n");
          });
        },
      }),
    ] as const;

    const client = createClientBuilder(
      streamErrorLibraryDefinition,
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
    const streamErrorLibraryDefinition = defineLibrary("stream-error-library");
    const streamErrorRoutes = [
      defineRoute({
        method: "GET",
        path: "/users-stream-error",
        outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
        handler: async (_ctx, { jsonStream }) => {
          return jsonStream(async (stream) => {
            await stream.writeRaw("this is not json lol\n\n");
          });
        },
      }),
    ] as const;

    const client = createClientBuilder(
      streamErrorLibraryDefinition,
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

  describe("mutation streaming", () => {
    test("should support streaming responses for mutations", async () => {
      const mutationStreamLibraryDefinition = defineLibrary("mutation-stream-library");
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

      const client = createClientBuilder(
        mutationStreamLibraryDefinition,
        clientConfig,
        mutationStreamRoutes,
      );
      const mutator = client.createMutator("POST", "/process-items");

      const result = await mutator.mutateQuery({
        body: { items: ["item1", "item2", "item3"] },
      });

      // Streaming mutations return only the first item
      expect(result).toEqual([
        { item: "item1", status: "processed" },
        { item: "item2", status: "processed" },
        { item: "item3", status: "processed" },
      ]);
    });

    test("should handle streaming mutations with mutatorStore", async () => {
      const mutationStreamLibraryDefinition = defineLibrary("mutation-stream-library");
      const mutationStreamRoutes = [
        defineRoute({
          method: "PUT",
          path: "/update-batch",
          inputSchema: z.object({ ids: z.array(z.number()) }),
          outputSchema: z.array(z.object({ id: z.number(), updated: z.boolean() })),
          handler: async (ctx, { jsonStream }) => {
            const data = await ctx.input?.valid();
            const { ids } = data!;
            return jsonStream(async (stream) => {
              for (const id of ids) {
                await stream.write({ id, updated: true });
                await stream.sleep(1);
              }
            });
          },
        }),
      ] as const;

      const client = createClientBuilder(
        mutationStreamLibraryDefinition,
        clientConfig,
        mutationStreamRoutes,
      );
      const mutator = client.createMutator("PUT", "/update-batch");

      const promise = new Promise((resolve, reject) => {
        const unsubscribe = mutator.mutatorStore.listen((state) => {
          if (!state.loading && state.data) {
            unsubscribe();
            resolve(state.data);
          }
          if (!state.loading && state.error) {
            unsubscribe();
            reject(state.error);
          }
        });
      });

      mutator.mutatorStore.mutate({ body: { ids: [1, 2, 3] } });

      const result = await promise;
      expect(result).toEqual([
        { id: 1, updated: true },
        { id: 2, updated: true },
        { id: 3, updated: true },
      ]);
    });

    test("should handle empty streaming response for mutations", async () => {
      const mutationStreamLibraryDefinition = defineLibrary("mutation-stream-library");
      const mutationStreamRoutes = [
        defineRoute({
          method: "DELETE",
          path: "/delete-items",
          inputSchema: z.object({ ids: z.array(z.number()) }),
          outputSchema: z.array(z.object({ id: z.number(), deleted: z.boolean() })),
          handler: async (_ctx, { jsonStream }) => {
            return jsonStream(async (_stream) => {
              // Don't write anything
            });
          },
        }),
      ] as const;

      const client = createClientBuilder(
        mutationStreamLibraryDefinition,
        clientConfig,
        mutationStreamRoutes,
      );
      const mutator = client.createMutator("DELETE", "/delete-items");

      // Empty streaming response should throw an error
      await expect(
        mutator.mutateQuery({
          body: { ids: [1, 2, 3] },
        }),
      ).rejects.toThrow("NDJSON stream contained no valid items");
    });
  });
});
