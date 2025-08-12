// import { test, expect, expectTypeOf } from "vitest";
// import { z } from "zod";
// import { createClientBuilder, type FragnoClientHook } from "./client";
// import { addRoute } from "../api/api";

// // Example library config similar to Chatno
// const exampleLibraryConfig = {
//   name: "example-api",
//   routes: [
//     addRoute({
//       method: "GET",
//       path: "/health",
//       handler: async () => {},
//     }),
//     addRoute({
//       method: "GET",
//       path: "/users",
//       outputSchema: z.array(
//         z.object({
//           id: z.number(),
//           name: z.string(),
//           email: z.string(),
//         }),
//       ),
//       handler: async () => [{ id: 1, name: "", email: "" }],
//     }),
//     addRoute({
//       method: "GET",
//       path: "/users/:id",
//       outputSchema: z.object({
//         id: z.number(),
//         name: z.string(),
//         email: z.string(),
//       }),
//       handler: async () => ({ id: 1, name: "", email: "" }),
//     }),
//     addRoute({
//       method: "POST",
//       path: "/users",
//       inputSchema: z.object({
//         name: z.string(),
//         email: z.string(),
//       }),
//       outputSchema: z.object({
//         id: z.number(),
//         name: z.string(),
//         email: z.string(),
//       }),
//       handler: async () => ({ id: 1, name: "", email: "" }),
//     }),
//     addRoute({
//       method: "GET",
//       path: "/config",
//       outputSchema: z.object({
//         version: z.string(),
//         features: z.array(z.string()),
//       }),
//       handler: async () => ({ version: "", features: [] }),
//     }),
//   ],
// } as const;

// test("FragnoClientBuilder integration test", () => {
//   // Create a client using the builder pattern
//   const client = createClientBuilder({ baseUrl: "https://api.example.com" }, exampleLibraryConfig)
//     .addHook("useHealth", "/health")
//     .addHook("useUsers", "/users")
//     .addHook("useUser", "/users/:id")
//     .addHook("useConfig", "/config")
//     .build();

//   // Verify the client has all the expected hooks
//   expect(client).toHaveProperty("useHealth");
//   expect(client).toHaveProperty("useUsers");
//   expect(client).toHaveProperty("useUser");
//   expect(client).toHaveProperty("useConfig");

//   // Verify hook structure
//   expect(client.useHealth).toHaveProperty("name");
//   expect(client.useHealth).toHaveProperty("store");
//   expect(client.useHealth.name).toBe("GET /health");

//   expect(client.useUsers.name).toBe("GET /users");
//   expect(client.useUser.name).toBe("GET /users/:id");
//   expect(client.useConfig.name).toBe("GET /config");

//   // Type safety verification - verify the hook has the expected structure
//   expectTypeOf(client.useHealth).toMatchTypeOf<FragnoClientHook<undefined>>();
//   expectTypeOf(client.useUsers).toEqualTypeOf<
//     FragnoClientHook<
//       z.ZodArray<
//         z.ZodObject<{
//           id: z.ZodNumber;
//           name: z.ZodString;
//           email: z.ZodString;
//         }>
//       >
//     >
//   >();
//   expectTypeOf(client.useUser).toEqualTypeOf<
//     FragnoClientHook<
//       z.ZodObject<{
//         id: z.ZodNumber;
//         name: z.ZodString;
//         email: z.ZodString;
//       }>
//     >
//   >();
//   expectTypeOf(client.useConfig).toEqualTypeOf<
//     FragnoClientHook<
//       z.ZodObject<{
//         version: z.ZodString;
//         features: z.ZodArray<z.ZodString>;
//       }>
//     >
//   >();
// });

// test("Builder pattern prevents non-GET routes", () => {
//   const builder = createClientBuilder({}, exampleLibraryConfig);

//   // These should work (GET routes)
//   expect(() => builder.addHook("useHealth", "/health")).not.toThrow();
//   expect(() => builder.addHook("useUsers", "/users")).not.toThrow();

//   // This should fail (trying to use a path that doesn't have a GET route)
//   expect(() => {
//     // @ts-expect-error - This path should not be allowed since it's not a GET route
//     builder.addHook("useInvalid", "/nonexistent-path");
//   }).toThrow("Route '/nonexistent-path' not found or is not a GET route");
// });

// test("Builder pattern provides type safety", () => {
//   const builder = createClientBuilder({}, exampleLibraryConfig);

//   // Valid paths should be accepted by TypeScript
//   const validBuilder = builder
//     .addHook("useHealth", "/health")
//     .addHook("useUsers", "/users")
//     .addHook("useUser", "/users/:id")
//     .addHook("useConfig", "/config");

//   expect(validBuilder).toBeDefined();

//   // Invalid paths should cause TypeScript errors (commented out to avoid compilation errors)
//   expect(() => {
//     // @ts-expect-error - Invalid path should not be allowed
//     builder.addHook("useInvalid", "/invalid");
//   }).toThrow();
// });

// test("Builder maintains immutability", () => {
//   const builder1 = createClientBuilder({}, exampleLibraryConfig);
//   const builder2 = builder1.addHook("useHealth", "/health");
//   const builder3 = builder2.addHook("useUsers", "/users");

//   // Each step should create a new builder instance
//   expect(builder1).not.toBe(builder2);
//   expect(builder2).not.toBe(builder3);

//   // Earlier builders should not have hooks from later steps
//   expect(builder1.build()).toEqual({});
//   expect(Object.keys(builder2.build())).toEqual(["useHealth"]);
//   expect(Object.keys(builder3.build())).toEqual(["useHealth", "useUsers"]);
// });

// test("Real-world usage example", () => {
//   // This simulates how a library like Chatno would use the builder
//   function createExampleClient(config = {}) {
//     return createClientBuilder(config, exampleLibraryConfig)
//       .addHook("useHealth", "/health")
//       .addHook("useUsers", "/users")
//       .addHook("useConfig", "/config")
//       .build();
//   }

//   const client = createExampleClient({ baseUrl: "https://api.example.com" });

//   // Verify the client works as expected
//   expect(client).toHaveProperty("useHealth");
//   expect(client).toHaveProperty("useUsers");
//   expect(client).toHaveProperty("useConfig");
//   expect(Object.keys(client)).toHaveLength(3);

//   // Type safety should be maintained
//   expectTypeOf(client.useHealth).toMatchTypeOf<FragnoClientHook<undefined>>();
//   expectTypeOf(client.useUsers).toEqualTypeOf<
//     FragnoClientHook<
//       z.ZodArray<
//         z.ZodObject<{
//           id: z.ZodNumber;
//           name: z.ZodString;
//           email: z.ZodString;
//         }>
//       >
//     >
//   >();
// });
