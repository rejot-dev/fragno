import { test, expect, expectTypeOf, describe } from "vitest";
import { z } from "zod";
import { createClientBuilder } from "./client";
import { defineRoute } from "../api/route";
import { defineFragment } from "../api/fragment-definition-builder";
import type { FragnoPublicClientConfig } from "../api/shared-types";

// Test route configurations
const testFragment = defineFragment("test-fragment").build();
const testRoutes = [
  // GET routes
  defineRoute({
    method: "GET",
    path: "/home",
    outputSchema: z.string(),
    handler: async (_ctx, { json }) => json("ok"),
  }),
  defineRoute({
    method: "GET",
    path: "/users",
    outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
    handler: async (_ctx, { json }) => json([{ id: 1, name: "" }]),
  }),
  defineRoute({
    method: "GET",
    path: "/users/:id" as const,
    outputSchema: z.object({ id: z.number(), name: z.string() }),
    handler: async ({ pathParams }, { json }) => json({ id: Number(pathParams.id), name: "" }),
  }),
  defineRoute({
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
  defineRoute({
    method: "POST",
    path: "/users",
    inputSchema: z.object({ name: z.string() }),
    outputSchema: z.object({ id: z.number(), name: z.string() }),
    handler: async (_ctx, { json }) => json({ id: 1, name: "" }),
  }),
  defineRoute({
    method: "PUT",
    path: "/users/:id",
    inputSchema: z.object({ name: z.string() }),
    handler: async (_ctx, { empty }) => {
      return empty();
    },
  }),
  defineRoute({
    method: "DELETE",
    path: "/users/:id",
    handler: async (_ctx, { empty }) => {
      return empty();
    },
  }),
] as const;

const testPublicConfig: FragnoPublicClientConfig = {
  baseUrl: "http://localhost:3000",
  mountRoute: "/api",
};

// Empty fragment config for edge case testing
const _emptyFragment = defineFragment("empty-fragment").build();
const _emptyRoutes = [] as const;

// Fragment config with no GET routes
const noGetFragment = defineFragment("no-get-fragment").build();
const noGetRoutes = [
  defineRoute({
    method: "POST",
    path: "/create",
    handler: async (_ctx, { json }) => json({}),
  }),
  defineRoute({
    method: "DELETE",
    path: "/delete/:id",
    handler: async (_ctx, { empty }) => {
      return empty();
    },
  }),
] as const;

describe("Hook builder (createHookBuilder) and createFragmentHook", () => {
  describe("basic functionality", () => {
    test("should create builder object", () => {
      const builder = createClientBuilder(testFragment, testPublicConfig, testRoutes);
      expectTypeOf(builder.createHook).toBeFunction();
    });

    test("should create hook for valid GET route", () => {
      const builder = createClientBuilder(testFragment, testPublicConfig, testRoutes);
      const hook = builder.createHook("/users");

      expect(hook).toHaveProperty("route");
      expect(hook).toHaveProperty("store");
      expect(hook.route.path).toBe("/users");
    });

    test("should create multiple hooks independently", () => {
      const builder = createClientBuilder(testFragment, testPublicConfig, testRoutes);
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
      const builder = createClientBuilder(testFragment, testPublicConfig, testRoutes);

      expect(() => {
        // @ts-expect-error - Testing runtime error for invalid path
        builder.createHook("/nonexistent");
      }).toThrow("Route '/nonexistent' not found or is not a GET route with an output schema.");
    });

    test("should throw error for fragment with no GET routes", () => {
      const builder = createClientBuilder(noGetFragment, testPublicConfig, noGetRoutes);

      expect(() => {
        // @ts-expect-error - Testing runtime error for no GET routes
        builder.createHook("/create");
      }).toThrow("Route '/create' not found or is not a GET route with an output schema.");
    });

    test("should handle complex route paths", () => {
      const complexFragment = defineFragment("complex-fragment").build();
      const complexRoutes = [
        defineRoute({
          method: "GET",
          path: "/api/v1/users/:userId/posts/:postId/comments/:commentId",
          outputSchema: z.object({ id: z.number(), content: z.string() }),
          handler: async (_ctx, { json }) => json({ id: 1, content: "" }),
        }),
        defineRoute({
          method: "GET",
          path: "/files/**:filepath",
          outputSchema: z.string(),
          handler: async (_ctx, { json }) => json("file"),
        }),
      ] as const;

      const builder = createClientBuilder(complexFragment, testPublicConfig, complexRoutes);
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
    const builder = createClientBuilder(testFragment, testPublicConfig, testRoutes);

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
    const chatnoFragment = defineFragment("chatno").build();
    const chatnoRoutes = [
      defineRoute({
        method: "GET",
        path: "/home",
        handler: async (_ctx, { empty }) => {
          return empty();
        },
      }),
      defineRoute({
        method: "GET",
        path: "/thing/**:path",
        handler: async (_ctx, { empty }) => {
          return empty();
        },
      }),
      defineRoute({
        method: "POST",
        path: "/echo",
        inputSchema: z.object({ number: z.number() }),
        outputSchema: z.string(),
        handler: async (_ctx, { json }) => json(""),
      }),
      defineRoute({
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
    ] as const;

    const builder = createClientBuilder(chatnoFragment, {}, chatnoRoutes);
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
      const builder = createClientBuilder(testFragment, config, testRoutes);
      const result = builder.createHook("/users");

      expect(result).toHaveProperty("store");
    });
  });
});
