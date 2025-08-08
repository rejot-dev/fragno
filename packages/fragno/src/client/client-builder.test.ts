import { test, expect, expectTypeOf, describe } from "vitest";
import { z } from "zod";
import { FragnoClientBuilder, createClientBuilder, type FragnoClientHook } from "./client";
import type { AnyFragnoLibrarySharedConfig, FragnoPublicClientConfig } from "../mod";
import { addRoute } from "../api/api";

// Test route configurations
const testLibraryConfig = {
  name: "test-library",
  routes: [
    // GET routes
    addRoute({
      method: "GET",
      path: "/",
      handler: async () => {},
    }),
    addRoute({
      method: "GET",
      path: "/users",
      outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
      handler: async () => [{ id: 1, name: "" }],
    }),
    addRoute({
      method: "GET",
      path: "/users/:id" as const,
      outputSchema: z.object({ id: z.number(), name: z.string() }),
      handler: async ({ pathParams }) => ({ id: Number(pathParams.id), name: "" }),
    }),
    addRoute({
      method: "GET",
      path: "/ai-config",
      outputSchema: z.object({
        apiProvider: z.enum(["openai", "anthropic"]),
        model: z.string(),
        systemPrompt: z.string(),
      }),
      handler: async () => ({
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
      handler: async () => ({ id: 1, name: "" }),
    }),
    addRoute({
      method: "PUT",
      path: "/users/:id",
      inputSchema: z.object({ name: z.string() }),
      handler: async () => {},
    }),
    addRoute({
      method: "DELETE",
      path: "/users/:id",
      handler: async () => {},
    }),
  ],
} as const;

const testPublicConfig: FragnoPublicClientConfig = {
  baseUrl: "http://localhost:3000",
  mountRoute: "/api",
};

// Empty library config for edge case testing
const emptyLibraryConfig = {
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
      handler: async () => {},
    }),
    addRoute({
      method: "DELETE",
      path: "/delete/:id",
      handler: async () => {},
    }),
  ],
} as const;

describe("FragnoClientBuilder", () => {
  describe("constructor and basic functionality", () => {
    test("should create builder instance", () => {
      const builder = new FragnoClientBuilder(testPublicConfig, testLibraryConfig);
      expect(builder).toBeInstanceOf(FragnoClientBuilder);
    });

    test("should create empty hooks object when no hooks added", () => {
      const builder = new FragnoClientBuilder(testPublicConfig, testLibraryConfig);
      const result = builder.build();
      expect(result).toEqual({});
    });
  });

  describe("addHook functionality", () => {
    test("should add hook for valid GET route", () => {
      const builder = new FragnoClientBuilder(testPublicConfig, testLibraryConfig);
      const result = builder.addHook("useUsers", "/users").build();

      expect(result).toHaveProperty("useUsers");
      expect(result.useUsers).toHaveProperty("name");
      expect(result.useUsers).toHaveProperty("store");
      expect(result.useUsers.name).toBe("GET /users");
    });

    test("should add multiple hooks", () => {
      const builder = new FragnoClientBuilder(testPublicConfig, testLibraryConfig);
      const result = builder
        .addHook("useUsers", "/users")
        .addHook("useUser", "/users/:id")
        .addHook("useAiConfig", "/ai-config")
        .build();

      expect(result).toHaveProperty("useUsers");
      expect(result).toHaveProperty("useUser");
      expect(result).toHaveProperty("useAiConfig");
      expect(Object.keys(result)).toHaveLength(3);
    });

    test("should maintain immutability - return new builder instance", () => {
      const builder1 = new FragnoClientBuilder(testPublicConfig, testLibraryConfig);
      const builder2 = builder1.addHook("useUsers", "/users");

      expect(builder1).not.toBe(builder2);
      expect(builder1.build()).toEqual({});
      expect(builder2.build()).toHaveProperty("useUsers");
    });

    test("should throw error for duplicate hook names", () => {
      const builder = new FragnoClientBuilder(testPublicConfig, testLibraryConfig);

      expect(() => {
        builder.addHook("useUsers", "/users").addHook("useUsers", "/users/:id");
      }).toThrow("Hook with name 'useUsers' already exists");
    });

    test("should throw error for non-existent route", () => {
      const builder = new FragnoClientBuilder(testPublicConfig, testLibraryConfig);

      expect(() => {
        // @ts-expect-error - Testing runtime error for invalid path
        builder.addHook("useInvalid", "/nonexistent");
      }).toThrow("Route '/nonexistent' not found or is not a GET route");
    });

    test("should throw error for non-GET route", () => {
      const builder = new FragnoClientBuilder(testPublicConfig, testLibraryConfig);

      expect(() => {
        // Test with a path that exists but is POST only
        // @ts-expect-error - Testing runtime error for POST route
        builder.addHook("createUser", "/create-user");
      }).toThrow("Route '/create-user' not found or is not a GET route");
    });

    test("should provide helpful error message with available GET routes", () => {
      const builder = new FragnoClientBuilder(testPublicConfig, testLibraryConfig);

      expect(() => {
        // @ts-expect-error - Testing runtime error
        builder.addHook("useInvalid", "/invalid");
      }).toThrowError(
        "Route '/invalid' not found or is not a GET route. Available GET routes: /, /users, /users/:id, /ai-config",
      );
    });
  });

  describe("edge cases", () => {
    test("should handle empty library config", () => {
      const builder = new FragnoClientBuilder(testPublicConfig, emptyLibraryConfig);
      const result = builder.build();
      expect(result).toEqual({});
    });

    test("should handle library config with no GET routes", () => {
      const builder = new FragnoClientBuilder(testPublicConfig, noGetLibraryConfig);
      const result = builder.build();
      expect(result).toEqual({});

      expect(() => {
        // @ts-expect-error - Testing runtime error for no GET routes
        builder.addHook("useCreate", "/create");
      }).toThrow("Route '/create' not found or is not a GET route");
    });

    test("should handle complex route paths", () => {
      const complexLibraryConfig = {
        name: "complex-library",
        routes: [
          addRoute({
            method: "GET",
            path: "/api/v1/users/:userId/posts/:postId/comments/:commentId",
            outputSchema: z.object({ id: z.number(), content: z.string() }),
            handler: async () => ({ id: 1, content: "" }),
          }),
          addRoute({
            method: "GET",
            path: "/files/**:filepath",
            handler: async () => {},
          }),
        ],
      } as const;

      const builder = new FragnoClientBuilder(testPublicConfig, complexLibraryConfig);
      const result = builder
        .addHook("useComment", "/api/v1/users/:userId/posts/:postId/comments/:commentId")
        .addHook("useFile", "/files/**:filepath")
        .build();

      expect(result).toHaveProperty("useComment");
      expect(result).toHaveProperty("useFile");
    });
  });

  describe("chaining and fluent interface", () => {
    test("should support method chaining", () => {
      const builder = new FragnoClientBuilder(testPublicConfig, testLibraryConfig);

      // This should not throw and should be chainable
      const result = builder
        .addHook("useRoot", "/")
        .addHook("useUsers", "/users")
        .addHook("useUser", "/users/:id")
        .addHook("useAiConfig", "/ai-config")
        .build();

      expect(Object.keys(result)).toHaveLength(4);
      expect(result).toHaveProperty("useRoot");
      expect(result).toHaveProperty("useUsers");
      expect(result).toHaveProperty("useUser");
      expect(result).toHaveProperty("useAiConfig");
    });

    test("should maintain type safety throughout chaining", () => {
      const builder = new FragnoClientBuilder(testPublicConfig, testLibraryConfig);

      const step1 = builder.addHook("useUsers", "/users");
      const step2 = step1.addHook("useUser", "/users/:id");
      const final = step2.build();

      // Each step should be a different builder instance
      expect(builder).not.toBe(step1);
      expect(step1).not.toBe(step2);

      // Final result should have both hooks
      expect(final).toHaveProperty("useUsers");
      expect(final).toHaveProperty("useUser");
    });
  });
});

describe("createClientBuilder factory function", () => {
  test("should create FragnoClientBuilder instance", () => {
    const builder = createClientBuilder(testPublicConfig, testLibraryConfig);
    expect(builder).toBeInstanceOf(FragnoClientBuilder);
  });

  test("should work the same as direct constructor", () => {
    const directBuilder = new FragnoClientBuilder(testPublicConfig, testLibraryConfig);
    const factoryBuilder = createClientBuilder(testPublicConfig, testLibraryConfig);

    const directResult = directBuilder.addHook("useUsers", "/users").build();
    const factoryResult = factoryBuilder.addHook("useUsers", "/users").build();

    // Compare structure instead of exact equality due to store instances
    expect(Object.keys(directResult)).toEqual(Object.keys(factoryResult));
    expect(directResult.useUsers.name).toBe(factoryResult.useUsers.name);
    expect(directResult.useUsers).toHaveProperty("store");
    expect(factoryResult.useUsers).toHaveProperty("store");
  });
});

describe("type safety tests", () => {
  test("should have correct types for hooks", () => {
    const builder = createClientBuilder(testPublicConfig, testLibraryConfig);
    const result = builder
      .addHook("useUsers", "/users")
      .addHook("useUser", "/users/:id")
      .addHook("useAiConfig", "/ai-config")
      .build();

    // Type tests - these should compile without errors
    expectTypeOf(result.useUsers).toEqualTypeOf<
      FragnoClientHook<z.ZodArray<z.ZodObject<{ id: z.ZodNumber; name: z.ZodString }>>>
    >();

    expectTypeOf(result.useUser).toEqualTypeOf<
      FragnoClientHook<z.ZodObject<{ id: z.ZodNumber; name: z.ZodString }>>
    >();

    expectTypeOf(result.useAiConfig).toEqualTypeOf<
      FragnoClientHook<
        z.ZodObject<{
          apiProvider: z.ZodEnum<{ openai: "openai"; anthropic: "anthropic" }>;
          model: z.ZodString;
          systemPrompt: z.ZodString;
        }>
      >
    >();
  });

  test("should only allow valid GET route paths", () => {
    const builder = createClientBuilder(testPublicConfig, testLibraryConfig);

    // These should compile (valid GET routes) - just test they don't throw
    expect(() => builder.addHook("useRoot", "/")).not.toThrow();
    expect(() => builder.addHook("useUsers", "/users")).not.toThrow();
    expect(() => builder.addHook("useUser", "/users/:id")).not.toThrow();
    expect(() => builder.addHook("useAiConfig", "/ai-config")).not.toThrow();

    expectTypeOf(builder.addHook)
      .parameter(1)
      .toEqualTypeOf<"/" | "/users" | "/users/:id" | "/ai-config">();

    expect(() => {
      // @ts-expect-error - Invalid path should not be allowed
      builder.addHook("useInvalid", "/non-existent");
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
          path: "/",
          handler: async () => {},
        }),
        addRoute({
          method: "GET",
          path: "/thing/**:path",
          handler: async () => {},
        }),
        addRoute({
          method: "POST",
          path: "/echo",
          inputSchema: z.object({ number: z.number() }),
          outputSchema: z.string(),
          handler: async () => "",
        }),
        addRoute({
          method: "GET",
          path: "/ai-config",
          outputSchema: z.object({
            apiProvider: z.enum(["openai", "anthropic"]),
            model: z.string(),
            systemPrompt: z.string(),
          }),
          handler: async () => ({
            apiProvider: "openai" as const,
            model: "gpt-4o",
            systemPrompt: "",
          }),
        }),
      ],
    } as const;

    const builder = createClientBuilder({}, chatnoLikeConfig);
    const result = builder.addHook("useAiConfig", "/ai-config").build();

    expect(result).toHaveProperty("useAiConfig");
    expect(result.useAiConfig.name).toBe("GET /ai-config");

    // Should not allow POST routes
    expect(() => {
      // @ts-expect-error - POST route should not be allowed
      builder.addHook("useEcho", "/echo");
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
      const result = builder.addHook("useUsers", "/users").build();

      expect(result).toHaveProperty("useUsers");
      expect(result.useUsers).toHaveProperty("store");
    });
  });
});
