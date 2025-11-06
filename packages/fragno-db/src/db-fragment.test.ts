import { test, expect, describe, expectTypeOf } from "vitest";
import { defineFragmentWithDatabase, type FragnoPublicConfigWithDatabase } from "./fragment";
import {
  createFragment,
  type FragnoPublicClientConfig,
  defineRoute,
  defineRoutes,
} from "@fragno-dev/core";
import { createClientBuilder } from "@fragno-dev/core/client";
import { schema, idColumn, column } from "./schema/create";
import type { AbstractQuery } from "./query/query";
import type { DatabaseAdapter } from "./mod";
import type { DatabaseRequestThisContext } from "./fragment";
import { z } from "zod";
import {
  fragnoDatabaseAdapterNameFakeSymbol,
  fragnoDatabaseAdapterVersionFakeSymbol,
} from "./adapters/adapters";

type Empty = Record<never, never>;

const mockDatabaseAdapter: DatabaseAdapter = {
  [fragnoDatabaseAdapterNameFakeSymbol]: "mock",
  [fragnoDatabaseAdapterVersionFakeSymbol]: 0,
  close: () => Promise.resolve(),
  createQueryEngine: () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return {} as any;
  },
  getSchemaVersion: () => Promise.resolve("0"),
  createMigrationEngine: () => {
    throw new Error("Not implemented");
  },
  createSchemaGenerator: () => {
    throw new Error("Not implemented");
  },
  createTableNameMapper: (namespace: string) => ({
    toPhysical: (logicalName: string) => `${logicalName}_${namespace}`,
    toLogical: (physicalName: string) => physicalName.replace(`_${namespace}`, ""),
  }),
  isConnectionHealthy: () => Promise.resolve(true),
};

describe("DatabaseFragmentBuilder", () => {
  describe("Type inference", () => {
    test("defineFragmentWithDatabase infers schema type from withDatabase", () => {
      const _testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const _fragment = defineFragmentWithDatabase("test").withDatabase(_testSchema);

      // Type check that withDatabase returns a builder with the schema
      expectTypeOf(_fragment.definition.name).toEqualTypeOf<string>();
    });

    test("withDatabase correctly transforms schema type", () => {
      const _testSchema1 = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const _testSchema2 = schema((s) =>
        s.addTable("posts", (t) =>
          t.addColumn("id", idColumn()).addColumn("title", column("string")),
        ),
      );

      const fragment1 = defineFragmentWithDatabase("test").withDatabase(_testSchema1);
      const fragment2 = fragment1.withDatabase(_testSchema2);

      // Type check that we can chain withDatabase
      expectTypeOf(fragment1.definition.name).toEqualTypeOf<string>();
      expectTypeOf(fragment2.definition.name).toEqualTypeOf<string>();
    });

    test("withDependencies has access to config, fragnoConfig, and orm", () => {
      const _testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const _fragment = defineFragmentWithDatabase("test")
        .withDatabase(_testSchema)
        .withDependencies(({ fragnoConfig, orm }) => {
          expectTypeOf(fragnoConfig).toEqualTypeOf<{ mountRoute?: string }>();
          expectTypeOf(orm).toEqualTypeOf<AbstractQuery<typeof _testSchema>>();

          return {
            userService: {
              getUser: async (id: string) => ({ id, name: "Test" }),
            },
          };
        });

      // Type check that the fragment has the expected structure
      expectTypeOf(_fragment.definition.name).toEqualTypeOf<string>();
    });

    test("providesService has access to config, fragnoConfig, deps, and db", () => {
      const _testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const _fragment = defineFragmentWithDatabase("test")
        .withDatabase(_testSchema)
        .withDependencies(({ orm }) => ({
          userRepo: {
            create: (name: string) => orm.create("users", { name }),
          },
        }))
        .providesService(({ fragnoConfig, deps, db }) => {
          expectTypeOf(fragnoConfig).toEqualTypeOf<{ mountRoute?: string }>();
          expectTypeOf(deps).toEqualTypeOf<{
            userRepo: {
              create: (name: string) => ReturnType<AbstractQuery<typeof _testSchema>["create"]>;
            };
          }>();
          expectTypeOf(db).toEqualTypeOf<AbstractQuery<typeof _testSchema>>();

          return {
            cacheService: {
              get: (_key: string) => "cached",
            },
          };
        });

      // Type check that the fragment has the expected structure
      expectTypeOf(_fragment.definition.name).toEqualTypeOf<string>();
    });
  });

  describe("Builder pattern", () => {
    test("Builder methods return new instances", () => {
      const _testSchema1 = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const _testSchema2 = schema((s) =>
        s.addTable("posts", (t) =>
          t.addColumn("id", idColumn()).addColumn("title", column("string")),
        ),
      );

      const builder1 = defineFragmentWithDatabase("test");
      const builder2 = builder1.withDatabase(_testSchema1);
      const builder3 = builder2.withDatabase(_testSchema2);
      const builder4 = builder3.withDependencies(() => ({ dep1: "value1" }));
      const builder5 = builder4.providesService(({ defineService }) =>
        defineService({ service1: "value1" }),
      );

      expect(builder1).not.toBe(builder2);
      expect(builder2).not.toBe(builder3);
      expect(builder3).not.toBe(builder4);
      expect(builder4).not.toBe(builder5);
    });

    test("Each builder step preserves previous configuration", () => {
      const _testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const fragment = defineFragmentWithDatabase("my-db-lib")
        .withDatabase(_testSchema)
        .withDependencies(({ orm }) => ({
          client: "test client",
          orm,
        }))
        .providesService(({ deps, defineService }) =>
          defineService({
            service: `Service using ${deps.client}`,
          }),
        );

      expect(fragment.definition.name).toBe("my-db-lib");
      expect(fragment.definition.dependencies).toBeDefined();
      expect(fragment.definition.services).toBeDefined();
    });
  });

  describe("Fragment instantiation", () => {
    test("createFragment works with database adapter", async () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const fragmentDef = defineFragmentWithDatabase("test-db")
        .withDatabase(testSchema)
        .withDependencies(({ orm }) => ({
          userService: {
            createUser: (name: string) => orm.create("users", { name }),
          },
        }))
        .providesService(({ defineService }) =>
          defineService({
            logger: { log: (s: string) => console.log(s) },
          }),
        );

      const options: FragnoPublicConfigWithDatabase = {
        databaseAdapter: mockDatabaseAdapter,
      };

      const fragment = createFragment(fragmentDef, {}, [], options);

      expect(fragment.config.name).toBe("test-db");
      expect(fragment.deps).toHaveProperty("userService");
      expect(fragment.services).toHaveProperty("logger");
    });

    test("throws error when database adapter is missing from dependencies", () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const fragmentDef = defineFragmentWithDatabase("test-db")
        .withDatabase(testSchema)
        .withDependencies(() => ({
          service: "test",
        }));

      expect(() => {
        // @ts-expect-error - Test case
        createFragment(fragmentDef, {}, [], {});
      }).toThrow(/requires a database adapter/);
    });

    test("throws error when database adapter is missing from services", () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const fragmentDef = defineFragmentWithDatabase("test-db")
        .withDatabase(testSchema)
        .withDependencies(() => ({
          service: "test",
        }))
        .providesService(({ defineService }) =>
          defineService({
            serviceValue: "test",
          }),
        );

      const options: FragnoPublicConfigWithDatabase = {
        databaseAdapter: mockDatabaseAdapter,
      };

      // Services are called after dependencies, so this should work
      const fragment = createFragment(fragmentDef, {}, [], options);
      expect(fragment.services).toHaveProperty("serviceValue");
    });

    test("throws error when schema is not provided via withDatabase", () => {
      const fragmentDef = defineFragmentWithDatabase<Empty>("test-db").withDependencies(() => ({
        service: "test",
      }));

      const options: FragnoPublicConfigWithDatabase = {
        databaseAdapter: mockDatabaseAdapter,
      };

      expect(() => {
        createFragment(fragmentDef, {}, [], options);
      }).toThrow(/requires a schema/);
    });

    test("orm is accessible in both dependencies and services", async () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      let depsOrm: AbstractQuery<typeof testSchema> | undefined;
      let servicesOrm: AbstractQuery<typeof testSchema> | undefined;

      const fragmentDef = defineFragmentWithDatabase("test-db")
        .withDatabase(testSchema)
        .withDependencies(({ orm }) => {
          depsOrm = orm;
          return { dep: "value" };
        })
        .providesService(({ db }) => {
          servicesOrm = db;
          return { service: "value" };
        });

      const options: FragnoPublicConfigWithDatabase = {
        databaseAdapter: mockDatabaseAdapter,
      };

      createFragment(fragmentDef, {}, [], options);

      expect(depsOrm).toBeDefined();
      expect(servicesOrm).toBeDefined();
    });
  });

  describe("Client builder integration", () => {
    test("createClientBuilder works with database fragment", () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const fragmentDef = defineFragmentWithDatabase("test-db")
        .withDatabase(testSchema)
        .providesService(({ db }) => {
          return {
            getUserById: (id: string) =>
              db.findFirst("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", id))),
          };
        });

      const routes = [
        defineRoute({
          method: "GET",
          path: "/users",
          outputSchema: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
            }),
          ),
          handler: async (_ctx, { json }) => json([]),
        }),
      ] as const;

      const clientConfig: FragnoPublicClientConfig = {
        baseUrl: "http://localhost:3000",
      };

      const builder = createClientBuilder(fragmentDef, clientConfig, routes);

      expect(builder).toBeDefined();
      expectTypeOf(builder.createHook).toBeFunction();

      const useUsers = builder.createHook("/users");
      expect(useUsers).toHaveProperty("route");
      expect(useUsers.route.path).toBe("/users");
    });
  });

  describe("Route handler this context", () => {
    test("this context has database functionality for database fragments", () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const fragmentDef = defineFragmentWithDatabase("test-db").withDatabase(testSchema);

      // Use defineRoutes with the fragment builder to get proper this typing
      const routesFactory = defineRoutes(fragmentDef).create(({ defineRoute }) => {
        return [
          defineRoute({
            method: "GET",
            path: "/test",
            handler: async function (_, { json }) {
              // Type check that this has getUnitOfWork method
              expectTypeOf(this).toHaveProperty("getUnitOfWork");
              expectTypeOf(this.getUnitOfWork).toBeFunction();
              return json({ ok: true });
            },
          }),
        ];
      });

      const options: FragnoPublicConfigWithDatabase = {
        databaseAdapter: mockDatabaseAdapter,
      };

      const fragment = createFragment(fragmentDef, {}, [routesFactory], options);
      expect(fragment).toBeDefined();
    });

    test("database fragment routes have access to database this context", async () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const fragmentDef = defineFragmentWithDatabase("test-db").withDatabase(testSchema);

      // Use defineRoutes with fragment builder reference for proper this typing
      const routesFactory = defineRoutes(fragmentDef).create(({ defineRoute }) => {
        return [
          defineRoute({
            method: "GET",
            path: "/test-uow",
            outputSchema: z.object({ result: z.string() }),
            handler: async function (_, { json }) {
              // The type system ensures 'this' is DatabaseRequestThisContext
              // which has getUnitOfWork method available
              expectTypeOf(this).toHaveProperty("getUnitOfWork");
              expectTypeOf(this.getUnitOfWork).toBeFunction();
              return json({ result: "ok" });
            },
          }),
        ];
      });

      const options: FragnoPublicConfigWithDatabase = {
        databaseAdapter: mockDatabaseAdapter,
      };

      const fragment = createFragment(fragmentDef, {}, [routesFactory], options);

      // Verify the fragment was created successfully
      expect(fragment).toBeDefined();
      expect(fragment.config.name).toBe("test-db");
    });
  });

  describe("providesService with this context", () => {
    test("providesService functions have access to DatabaseRequestThisContext", () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      // Define a service with a function that uses 'this'
      const userService = {
        getCurrentUser: function (this: DatabaseRequestThisContext, userId: string) {
          // Type check that this has getUnitOfWork method
          expectTypeOf(this).toHaveProperty("getUnitOfWork");
          expectTypeOf(this.getUnitOfWork).toBeFunction();
          return { id: userId, name: "Test User" };
        },
      };

      // This should compile without errors because the function has the correct this type
      const fragmentDef = defineFragmentWithDatabase("test-service")
        .withDatabase(testSchema)
        .providesService("userService", ({ defineService }) => defineService(userService));

      expect(fragmentDef).toBeDefined();
      expect(typeof fragmentDef.definition.providedServices).toBe("function");
    });

    test("providesService binds services correctly", async () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const userService = {
        testMethod: function (this: DatabaseRequestThisContext) {
          // At runtime, this should have access to getUnitOfWork
          const uow = this.getUnitOfWork();
          return { hasUow: !!uow };
        },
      };

      const fragmentDef = defineFragmentWithDatabase("test-service-runtime")
        .withDatabase(testSchema)
        .providesService("userService", ({ defineService }) => defineService(userService));

      // Verify the definition has the provided service (now it's a factory function)
      expect(fragmentDef.definition.providedServices).toBeDefined();
      expect(typeof fragmentDef.definition.providedServices).toBe("function");

      // Type checking is the main test here - if the service functions
      // don't have the correct `this` type, TypeScript will error at compile time
    });
  });
});
