import { test, expect, expectTypeOf, describe } from "vitest";
import { z } from "zod";
import { createClientBuilder } from "./client";
import { addRoute } from "../api/api";
import type { AnyFragnoLibrarySharedConfig, FragnoPublicClientConfig } from "../api/library";

// Test route configurations
const testLibraryConfig = {
  name: "test-library",
  routes: [
    // GET routes
    addRoute({
      method: "GET",
      path: "/home",
      outputSchema: z.string(),
      handler: async (_ctx, { json }) => json("ok"),
    }),
    addRoute({
      method: "GET",
      path: "/users",
      outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
      handler: async (_ctx, { json }) => json([{ id: 1, name: "" }]),
    }),
    addRoute({
      method: "GET",
      path: "/users/:id" as const,
      outputSchema: z.object({ id: z.number(), name: z.string() }),
      handler: async ({ pathParams }, { json }) => json({ id: Number(pathParams.id), name: "" }),
    }),
    addRoute({
      method: "GET",
      path: "/ai-config",
      outputSchema: z.object({
        apiProvider: z.enum(["openai", "anthropic"]),
        model: z.string(),
        systemPrompt: z.string(),
      }),
      handler: async (_ctx, { json }) =>
        json({
          apiProvider: "openai" as const,
          model: "gpt-4o",
          systemPrompt: "",
        }),
    }),
    // Non-GET routes (should not be available for hooks)
    addRoute({
      method: "POST",
      path: "/users",
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ id: z.number(), name: z.string() }),
      handler: async (_ctx, { json }) => json({ id: 1, name: "" }),
    }),
    addRoute({
      method: "PUT",
      path: "/users/:id",
      inputSchema: z.object({ name: z.string() }),
      handler: async (_ctx, { empty }) => {
        return empty();
      },
    }),
    addRoute({
      method: "DELETE",
      path: "/users/:id",
      handler: async (_ctx, { empty }) => {
        return empty();
      },
    }),
  ],
} as const;

const testPublicConfig: FragnoPublicClientConfig = {
  baseUrl: "http://localhost:3000",
  mountRoute: "/api",
};

// Empty library config for edge case testing
const _emptyLibraryConfig = {
  name: "empty-library",
  routes: [],
} as const satisfies AnyFragnoLibrarySharedConfig;

// Library config with no GET routes
const noGetLibraryConfig = {
  name: "no-get-library",
  routes: [
    addRoute({
      method: "POST",
      path: "/create",
      handler: async (_ctx, { json }) => json({}),
    }),
    addRoute({
      method: "DELETE",
      path: "/delete/:id",
      handler: async (_ctx, { empty }) => {
        return empty();
      },
    }),
  ],
} as const;

describe("Hook builder (createHookBuilder) and createLibraryHook", () => {
  describe("basic functionality", () => {
    test("should create builder object", () => {
      const builder = createClientBuilder(testPublicConfig, testLibraryConfig);
      expectTypeOf(builder.createHook).toBeFunction();
    });

    test("should create hook for valid GET route", () => {
      const builder = createClientBuilder(testPublicConfig, testLibraryConfig);
      const hook = builder.createHook("/users");

      expect(hook).toHaveProperty("route");
      expect(hook).toHaveProperty("store");
      expect(hook.route.path).toBe("/users");
    });

    test("should create multiple hooks independently", () => {
      const builder = createClientBuilder(testPublicConfig, testLibraryConfig);
      const usersHook = builder.createHook("/users");
      const userHook = builder.createHook("/users/:id");
      const aiHook = builder.createHook("/ai-config");

      expect(usersHook.route.path).toBe("/users");
      expect(userHook.route.path).toBe("/users/:id");
      expect(aiHook.route.path).toBe("/ai-config");
    });
  });

  describe("error handling", () => {
    test("should throw error for non-existent route", () => {
      const builder = createClientBuilder(testPublicConfig, testLibraryConfig);

      expect(() => {
        // @ts-expect-error - Testing runtime error for invalid path
        builder.createHook("/nonexistent");
      }).toThrow("Route '/nonexistent' not found or is not a GET route with an output schema.");
    });

    test("should throw error for library with no GET routes", () => {
      const builder = createClientBuilder(testPublicConfig, noGetLibraryConfig);

      expect(() => {
        // @ts-expect-error - Testing runtime error for no GET routes
        builder.createHook("/create");
      }).toThrow("Route '/create' not found or is not a GET route with an output schema.");
    });

    test("should handle complex route paths", () => {
      const complexLibraryConfig = {
        name: "complex-library",
        routes: [
          addRoute({
            method: "GET",
            path: "/api/v1/users/:userId/posts/:postId/comments/:commentId",
            outputSchema: z.object({ id: z.number(), content: z.string() }),
            handler: async (_ctx, { json }) => json({ id: 1, content: "" }),
          }),
          addRoute({
            method: "GET",
            path: "/files/**:filepath",
            outputSchema: z.string(),
            handler: async (_ctx, { json }) => json("file"),
          }),
        ],
      } as const;

      const builder = createClientBuilder(testPublicConfig, complexLibraryConfig);
      const commentHook = builder.createHook(
        "/api/v1/users/:userId/posts/:postId/comments/:commentId",
      );
      const fileHook = builder.createHook("/files/**:filepath");

      expect(commentHook.route.path).toBe(
        "/api/v1/users/:userId/posts/:postId/comments/:commentId",
      );
      expect(fileHook.route.path).toBe("/files/**:filepath");
    });
  });
});

describe("type safety tests", () => {
  test("should only allow valid GET route paths", () => {
    const builder = createClientBuilder(testPublicConfig, testLibraryConfig);

    // These should compile (valid GET routes)
    expect(() => builder.createHook("/home")).not.toThrow();
    expect(() => builder.createHook("/users")).not.toThrow();
    expect(() => builder.createHook("/users/:id")).not.toThrow();
    expect(() => builder.createHook("/ai-config")).not.toThrow();

    expectTypeOf(builder.createHook)
      .parameter(0)
      .toEqualTypeOf<"/home" | "/users" | "/users/:id" | "/ai-config">();

    expect(() => {
      // @ts-expect-error - Invalid path should not be allowed
      builder.createHook("/non-existent");
    }).toThrow();
  });
});

describe("real-world usage scenarios", () => {
  test("should work with Chatno-like configuration", () => {
    const chatnoLikeConfig = {
      name: "chatno",
      routes: [
        addRoute({
          method: "GET",
          path: "/home",
          handler: async (_ctx, { empty }) => {
            return empty();
          },
        }),
        addRoute({
          method: "GET",
          path: "/thing/**:path",
          handler: async (_ctx, { empty }) => {
            return empty();
          },
        }),
        addRoute({
          method: "POST",
          path: "/echo",
          inputSchema: z.object({ number: z.number() }),
          outputSchema: z.string(),
          handler: async (_ctx, { json }) => json(""),
        }),
        addRoute({
          method: "GET",
          path: "/ai-config",
          outputSchema: z.object({
            apiProvider: z.enum(["openai", "anthropic"]),
            model: z.string(),
            systemPrompt: z.string(),
          }),
          handler: async (_ctx, { json }) =>
            json({
              apiProvider: "openai" as const,
              model: "gpt-4o",
              systemPrompt: "",
            }),
        }),
      ],
    } as const;

    const builder = createClientBuilder({}, chatnoLikeConfig);
    const hook = builder.createHook("/ai-config");

    expect(hook).toHaveProperty("route");

    // Should not allow POST routes (compile-time) and should throw at runtime if forced
    expect(() => {
      // @ts-expect-error - POST route should not be allowed
      builder.createHook("/echo");
    }).toThrow();
  });

  test("should handle different public configs", () => {
    const configs = [
      {},
      { baseUrl: "https://api.example.com" },
      { mountRoute: "/v1" },
      { baseUrl: "https://api.example.com", mountRoute: "/v1" },
    ];

    configs.forEach((config) => {
      const builder = createClientBuilder(config, testLibraryConfig);
      const result = builder.createHook("/users");

      expect(result).toHaveProperty("store");
    });
  });
});
