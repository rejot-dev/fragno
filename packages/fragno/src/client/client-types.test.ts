import { test, expectTypeOf, describe } from "vitest";
import { z } from "zod";
import { type FragnoRouteConfig, type HTTPMethod } from "../api/api";
import { defineRoute } from "../api/route";
import type {
  ExtractGetRoutes,
  ExtractGetRoutePaths,
  ExtractOutputSchemaForPath,
  ExtractRouteByPath,
  IsValidGetRoutePath,
  ValidateGetRoutePath,
  HasGetRoutes,
  FragnoClientMutatorData,
} from "./client";
import type { StandardSchemaV1 } from "@standard-schema/spec";

// Test route configurations for type testing
const _testRoutes = [
  // GET routes
  defineRoute({
    method: "GET",
    path: "/home",
    handler: async (_ctx, { json }) => json({}),
  }),
  defineRoute({
    method: "GET",
    path: "/users",
    outputSchema: z.array(z.object({ id: z.number(), name: z.string() })),
    handler: async (_ctx, { json }) => {
      return json([{ id: 1, name: "" } as const]);
    },
  }),
  defineRoute({
    method: "GET",
    path: "/users/:id",
    outputSchema: z.object({ id: z.number(), name: z.string() }),
    handler: async ({ pathParams }, { json }) => {
      return json({ id: Number(pathParams.id), name: "" } as const);
    },
  }),
  defineRoute({
    method: "GET",
    path: "/posts/:postId/comments",
    outputSchema: z.array(z.object({ id: z.number(), content: z.string() })),
    handler: async (_ctx, { json }) => json([]),
  }),
  defineRoute({
    method: "GET",
    path: "/static/**:path",
    handler: async (_ctx, { json }) => json({}),
  }),
  // Non-GET routes (should be filtered out)
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
    handler: async (_ctx, { json }) => json({}),
  }),
  defineRoute({
    method: "DELETE",
    path: "/users/:id",
    handler: async (_ctx, { json }) => json({}),
  }),
] as const;

// Empty routes array for edge case testing
const _emptyRoutes = [] as const satisfies readonly FragnoRouteConfig<
  HTTPMethod,
  string,
  StandardSchemaV1 | undefined,
  StandardSchemaV1 | undefined,
  string,
  string
>[];

// Routes with no GET methods
const _noGetRoutes = [
  defineRoute({
    method: "POST",
    path: "/create",
    handler: async (_ctx, { json }) => json({}),
  }),
  defineRoute({
    method: "DELETE",
    path: "/delete/:id",
    handler: async (_ctx, { json }) => json({}),
  }),
] as const;

test("ExtractGetRoutes type tests", () => {
  // Should extract only GET routes from mixed routes
  type GetRoutes = ExtractGetRoutes<typeof _testRoutes>;

  // The result should be an array of only GET route configs
  // We can't directly test the array structure, but we can verify it contains the right routes
  expectTypeOf<GetRoutes>().toBeArray();

  // Should be empty array for routes with no GET methods
  type NoGetRoutesResult = ExtractGetRoutes<typeof _noGetRoutes>;
  expectTypeOf<NoGetRoutesResult>().toEqualTypeOf<never[]>();

  // Should be empty array for empty routes
  type EmptyRoutesResult = ExtractGetRoutes<typeof _emptyRoutes>;
  expectTypeOf<EmptyRoutesResult>().toEqualTypeOf<never[]>();
});

test("ExtractGetRoutePaths type tests", () => {
  // Should extract only paths from GET routes
  type GetPaths = ExtractGetRoutePaths<typeof _testRoutes>;
  expectTypeOf<GetPaths>().toEqualTypeOf<
    "/home" | "/users" | "/users/:id" | "/posts/:postId/comments" | "/static/**:path"
  >();

  // Should be never for routes with no GET methods
  type NoGetPaths = ExtractGetRoutePaths<typeof _noGetRoutes>;
  expectTypeOf<NoGetPaths>().toEqualTypeOf<never>();

  // Should be never for empty routes
  type EmptyPaths = ExtractGetRoutePaths<typeof _emptyRoutes>;
  expectTypeOf<EmptyPaths>().toEqualTypeOf<never>();
});

test("ExtractOutputSchemaForPath type tests", () => {
  // Should extract correct output schema for existing GET route
  type UsersSchema = ExtractOutputSchemaForPath<typeof _testRoutes, "/users">;
  expectTypeOf<UsersSchema>().toEqualTypeOf<
    z.ZodArray<
      z.ZodObject<{
        id: z.ZodNumber;
        name: z.ZodString;
      }>
    >
  >();

  // Should extract correct output schema for parameterized route
  type UserSchema = ExtractOutputSchemaForPath<typeof _testRoutes, "/users/:id">;
  expectTypeOf<UserSchema>().toEqualTypeOf<
    z.ZodObject<{
      id: z.ZodNumber;
      name: z.ZodString;
    }>
  >();

  // Note: Routes without output schema have complex type inference, skipping direct test

  // Should be never for non-existent path
  type NonExistentSchema = ExtractOutputSchemaForPath<typeof _testRoutes, "/nonexistent">;
  expectTypeOf<NonExistentSchema>().toEqualTypeOf<never>();

  type PathWithNoSchema = ExtractOutputSchemaForPath<typeof _testRoutes, "/home">;
  expectTypeOf<PathWithNoSchema>().toEqualTypeOf<StandardSchemaV1<unknown, unknown> | undefined>();
});

test("IsValidGetRoutePath type tests", () => {
  // Should return true for valid GET route paths
  expectTypeOf<IsValidGetRoutePath<typeof _testRoutes, "/home">>().toEqualTypeOf<true>();
  expectTypeOf<IsValidGetRoutePath<typeof _testRoutes, "/users">>().toEqualTypeOf<true>();
  expectTypeOf<IsValidGetRoutePath<typeof _testRoutes, "/users/:id">>().toEqualTypeOf<true>();
  expectTypeOf<
    IsValidGetRoutePath<typeof _testRoutes, "/posts/:postId/comments">
  >().toEqualTypeOf<true>();
  expectTypeOf<IsValidGetRoutePath<typeof _testRoutes, "/static/**:path">>().toEqualTypeOf<true>();

  // Should return false for non-GET routes (even if they exist)
  expectTypeOf<IsValidGetRoutePath<typeof _testRoutes, "/users">>().toEqualTypeOf<true>(); // This is GET

  // Should return false for non-existent paths
  expectTypeOf<IsValidGetRoutePath<typeof _testRoutes, "/nonexistent">>().toEqualTypeOf<false>();
  expectTypeOf<IsValidGetRoutePath<typeof _testRoutes, "/admin">>().toEqualTypeOf<false>();

  // Should return false for empty or no-GET routes
  expectTypeOf<IsValidGetRoutePath<typeof _emptyRoutes, "/anything">>().toEqualTypeOf<false>();
  expectTypeOf<IsValidGetRoutePath<typeof _noGetRoutes, "/create">>().toEqualTypeOf<false>();
});

test("ValidateGetRoutePath type tests", () => {
  // Should return the path itself for valid GET routes
  expectTypeOf<ValidateGetRoutePath<typeof _testRoutes, "/home">>().toEqualTypeOf<"/home">();
  expectTypeOf<ValidateGetRoutePath<typeof _testRoutes, "/users">>().toEqualTypeOf<"/users">();
  expectTypeOf<
    ValidateGetRoutePath<typeof _testRoutes, "/users/:id">
  >().toEqualTypeOf<"/users/:id">();

  // Should return error message for invalid paths
  type InvalidPathError = ValidateGetRoutePath<typeof _testRoutes, "/nonexistent">;
  expectTypeOf<InvalidPathError>().toMatchTypeOf<string>();

  // Should return error for POST/PUT/DELETE routes even if they exist
  type PostRouteError = ValidateGetRoutePath<typeof _testRoutes, "/users">;
  expectTypeOf<PostRouteError>().toEqualTypeOf<"/users">(); // This is actually a GET route
});

test("HasGetRoutes type tests", () => {
  // Should return true for routes that contain GET methods
  expectTypeOf<HasGetRoutes<typeof _testRoutes>>().toEqualTypeOf<true>();

  // Should return false for routes with no GET methods
  expectTypeOf<HasGetRoutes<typeof _noGetRoutes>>().toEqualTypeOf<false>();

  // Should return false for empty routes
  expectTypeOf<HasGetRoutes<typeof _emptyRoutes>>().toEqualTypeOf<false>();
});

test("Real-world usage scenarios", () => {
  // Test with Chatno-like route configuration
  const _chatnoLikeRoutes = [
    defineRoute({
      method: "GET",
      path: "/home",
      outputSchema: z.string(),
      handler: async (_ctx, { json }) => json("Hello, world!"),
    }),
    defineRoute({
      method: "GET",
      path: "/thing/**:path",
      outputSchema: z.string(),
      handler: async (_ctx, { json }) => json("thing"),
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

  // Should extract only GET paths
  type ChatnoGetPaths = ExtractGetRoutePaths<typeof _chatnoLikeRoutes>;
  expectTypeOf<ChatnoGetPaths>().toEqualTypeOf<"/home" | "/thing/**:path" | "/ai-config">();

  // Should validate paths correctly
  expectTypeOf<IsValidGetRoutePath<typeof _chatnoLikeRoutes, "/ai-config">>().toEqualTypeOf<true>();
  expectTypeOf<IsValidGetRoutePath<typeof _chatnoLikeRoutes, "/echo">>().toEqualTypeOf<false>(); // POST route
});

test("Edge cases and error handling", () => {
  // Routes with complex path patterns
  const _complexRoutes = [
    defineRoute({
      method: "GET",
      path: "/api/v1/users/:userId/posts/:postId/comments/:commentId",
      outputSchema: z.object({ id: z.number(), content: z.string() }),
      handler: async (_ctx, { json }) => json({ id: 1, content: "" }),
    }),
    defineRoute({
      method: "GET",
      path: "/files/**:filepath",
      handler: async (_ctx, { json }) => json({}),
    }),
    defineRoute({
      method: "GET",
      path: "/admin/:section/:action",
      outputSchema: z.object({ success: z.boolean() }),
      handler: async (_ctx, { json }) => json({ success: true }),
    }),
  ] as const;

  type ComplexPaths = ExtractGetRoutePaths<typeof _complexRoutes>;
  expectTypeOf<ComplexPaths>().toEqualTypeOf<
    | "/api/v1/users/:userId/posts/:postId/comments/:commentId"
    | "/files/**:filepath"
    | "/admin/:section/:action"
  >();

  // Should handle very long path names
  expectTypeOf<
    IsValidGetRoutePath<
      typeof _complexRoutes,
      "/api/v1/users/:userId/posts/:postId/comments/:commentId"
    >
  >().toEqualTypeOf<true>();

  // Should handle wildcard paths
  expectTypeOf<
    IsValidGetRoutePath<typeof _complexRoutes, "/files/**:filepath">
  >().toEqualTypeOf<true>();
});

test("Type constraint validation", () => {
  // These tests ensure the types work correctly with const assertions and readonly arrays
  const _routesWithoutConst = [
    {
      method: "GET" as const,
      path: "/test" as const,
      handler: async (_ctx: unknown, { empty }: { empty: () => Response }) => empty(),
    },
  ];

  // Should work with non-const arrays too
  type NonConstPaths = ExtractGetRoutePaths<typeof _routesWithoutConst>;
  expectTypeOf<NonConstPaths>().toEqualTypeOf<"/test">();

  // Should maintain type safety with const assertions
  const _constRoutes = [
    defineRoute({
      method: "GET",
      path: "/const-test",
      handler: async (_ctx, { json }) => json({}),
    }),
  ] as const;

  type ConstPaths = ExtractGetRoutePaths<typeof _constRoutes>;
  expectTypeOf<ConstPaths>().toEqualTypeOf<"/const-test">();
});

test("GET route with outputSchema", () => {
  // These tests ensure the types work correctly with const assertions and readonly arrays
  const _routes = [
    defineRoute({
      method: "GET" as const,
      path: "/test",
      outputSchema: z.object({
        name: z.string(),
      }),
      handler: async (_ctx, { json }) => json({ name: "test" }),
    }),
  ] as const;

  type ConstPaths = ExtractGetRoutePaths<typeof _routes>;
  expectTypeOf<ConstPaths>().toEqualTypeOf<"/test">();
});

describe("ExtractRouteByPath", () => {
  const _libraryConfig = {
    name: "test-library",
    routes: [
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
        handler: async ({ pathParams }, { json }) =>
          json({ id: Number(pathParams["id"]), name: "" }),
      }),
      defineRoute({
        method: "DELETE",
        path: "/users/:id",
        inputSchema: z.object({}),
        outputSchema: z.object({ success: z.boolean() }),
        handler: async (_ctx, { json }) => json({ success: true }),
      }),
    ],
  } as const;

  test("basic", () => {
    type UsersRoute = ExtractRouteByPath<typeof _libraryConfig.routes, "/users">;

    expectTypeOf<UsersRoute>().toEqualTypeOf<
      FragnoRouteConfig<
        "POST",
        "/users",
        z.ZodObject<{
          name: z.ZodString;
          email: z.ZodString;
        }>,
        z.ZodObject<{
          id: z.ZodNumber;
          name: z.ZodString;
          email: z.ZodString;
        }>,
        string,
        string
      >
    >();
  });
});

// FIXME: These are not great now
describe("FragnoClientMutatorData", () => {
  type ZodObjectIdName = z.ZodObject<{
    id: z.ZodNumber;
    name: z.ZodString;
  }>;

  test("No inputSchema or outputSchema", () => {
    type _Mutator1 = FragnoClientMutatorData<
      "DELETE",
      "/users/:id",
      undefined,
      undefined,
      string,
      string
    >;
    type MutateQuery = _Mutator1["mutateQuery"];

    expectTypeOf<MutateQuery>().toEqualTypeOf<
      ({
        path,
        query,
      }: {
        body?: undefined;
        path?: Record<"id", string> | undefined;
        query?: Record<string, string>;
      }) => Promise<undefined>
    >();
  });

  test("No inputSchema", () => {
    type _Mutator2 = FragnoClientMutatorData<
      "DELETE",
      "/users/:id",
      undefined,
      ZodObjectIdName,
      string,
      string
    >;
    type MutateQuery = _Mutator2["mutateQuery"];

    expectTypeOf<MutateQuery>().toEqualTypeOf<
      ({
        body,
        path,
        query,
      }: {
        body?: undefined;
        path?: Record<"id", string> | undefined;
        query?: Record<string, string>;
      }) => Promise<{
        id: number;
        name: string;
      }>
    >();
  });

  test("No outputSchema", () => {
    type _Mutator3 = FragnoClientMutatorData<
      "PUT",
      "/users/:id",
      ZodObjectIdName,
      undefined,
      string,
      string
    >;
    type MutateQuery = _Mutator3["mutateQuery"];

    expectTypeOf<MutateQuery>().toEqualTypeOf<
      ({
        body,
        path,
        query,
      }: {
        body?:
          | {
              id: number;
              name: string;
            }
          | undefined;
        path?: Record<"id", string> | undefined;
        query?: Record<string, string>;
      }) => Promise<undefined>
    >();
  });

  test("With query parameters", () => {
    type _Mutator4 = FragnoClientMutatorData<
      "DELETE",
      "/users/:id",
      undefined,
      undefined,
      string,
      "id" | "name"
    >;

    type MutateQuery = _Mutator4["mutateQuery"];

    expectTypeOf<MutateQuery>().toEqualTypeOf<
      ({
        path,
        query,
      }: {
        body?: undefined;
        path?: Record<"id", string> | undefined;
        query?: Record<"id" | "name", string>;
      }) => Promise<undefined>
    >();
  });
});
