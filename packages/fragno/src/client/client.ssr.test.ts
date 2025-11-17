/**
 * Our tests run with happy-dom by default, this defines `window` making it so that we `fetch()`
 * instead of calling handlers directly. In this file we override it to be "node", so that `window`
 * is not defined.
 *
 * @vitest-environment node
 */

import { describe, expect, test } from "vitest";
import { type FragnoPublicClientConfig } from "../mod";
import { createClientBuilder } from "./client";
import { defineRoute } from "../api/route";
import { defineFragment } from "../api/fragment-definition-builder";
import { z } from "zod";
import { createAsyncIteratorFromCallback, waitForAsyncIterator } from "../util/async";

describe("server side rendering", () => {
  const testFragmentDefinition = defineFragment("test-fragment").build();
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
    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
    const clientObj = {
      useUsers: client.createHook("/users"),
    };

    const { useUsers } = clientObj;

    const data = await useUsers.query({});

    expect(data).toEqual([{ id: 1, name: "John" }]);
  });

  test("should be able to use the store server side", async () => {
    const client = createClientBuilder(testFragmentDefinition, clientConfig, testRoutes);
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

  describe("mutation streaming", () => {
    test("should support streaming responses for mutations", async () => {
      const mutationStreamFragmentDefinition = defineFragment("mutation-stream-fragment");
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
        mutationStreamFragmentDefinition,
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

    test("should immediately return empty array for streaming mutations", async () => {
      const mutationStreamFragmentDefinition = defineFragment("mutation-stream-fragment");
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
        mutationStreamFragmentDefinition,
        clientConfig,
        mutationStreamRoutes,
      );
      const mutator = client.createMutator("PUT", "/update-batch");

      const result = await mutator.mutatorStore.mutate({ body: { ids: [1, 2, 3] } });
      // empty array
      expect(result).toEqual([]);
    });

    test("should handle empty streaming response for mutations", async () => {
      const mutationStreamFragmentDefinition = defineFragment("mutation-stream-fragment");
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
        mutationStreamFragmentDefinition,
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
