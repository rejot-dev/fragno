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
});
