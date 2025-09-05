import { test, expect, describe, vi, beforeEach, afterEach, assert } from "vitest";
import { createClientBuilder, type FragnoPublicClientConfig } from "../mod";
import { addRoute } from "../api/api";
import { z } from "zod";
import { useFragno } from "./vue";
import { waitFor } from "@testing-library/vue";
import { ref } from "vue";

global.fetch = vi.fn();

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

  test("Hook should reactively update", async () => {
    const testLibraryConfig = {
      name: "test-library",
      routes: [
        addRoute({
          method: "GET",
          path: "/users",
          outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
          handler: async (_ctx, { json }) => json([{ id: 1, name: "John" }]),
        }),
      ],
    };

    vi.mocked(global.fetch).mockImplementationOnce(
      async () =>
        ({
          headers: new Headers(),
          ok: true,
          json: async () => [{ id: 1, name: "John" }],
        }) as Response,
    );

    const client = createClientBuilder(clientConfig, testLibraryConfig);
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

  test("Should support path parameters w/ reactive updating", async () => {
    const testLibraryConfig = {
      name: "test-library",
      routes: [
        addRoute({
          method: "GET",
          path: "/users/:id",
          outputSchema: z.object({ id: z.number(), name: z.string() }),
          handler: async ({ pathParams }, { json }) =>
            json({ id: Number(pathParams["id"]), name: "John" }),
        }),
      ],
    };

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

    const client = createClientBuilder(clientConfig, testLibraryConfig);
    const clientObj = {
      useUser: client.createHook("/users/:id"),
    };

    const id = ref("123");

    const { useUser } = useFragno(clientObj);
    const { loading, data, error } = useUser({ pathParams: { id } });

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
});
