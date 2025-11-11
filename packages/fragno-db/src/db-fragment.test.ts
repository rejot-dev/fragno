import { test, expect, describe, expectTypeOf, assert } from "vitest";
import { defineFragmentWithDatabase, type FragnoPublicConfigWithDatabase } from "./fragment";
import {
  createFragment,
  instantiateFragment,
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
    return {
      createUnitOfWork: () => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
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
      expect(fragmentDef.definition.providedServices).toBeDefined();
      expect(typeof fragmentDef.definition.providedServices).toBe("object");
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

      // Verify the definition has the provided service (now it's an object with factory functions)
      expect(fragmentDef.definition.providedServices).toBeDefined();
      expect(typeof fragmentDef.definition.providedServices).toBe("object");

      // Type checking is the main test here - if the service functions
      // don't have the correct `this` type, TypeScript will error at compile time
    });

    test("providesService with direct object (no factory)", () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const fragmentDef = defineFragmentWithDatabase("test-direct")
        .withDatabase(testSchema)
        .providesService("helpers", {
          slugify: (text: string) => text.toLowerCase().replace(/\s+/g, "-"),
          capitalize: (text: string) => text.charAt(0).toUpperCase() + text.slice(1),
        });

      const options: FragnoPublicConfigWithDatabase = {
        databaseAdapter: mockDatabaseAdapter,
      };

      const fragment = createFragment(fragmentDef, {}, [], options);

      expect(fragment.services.helpers).toBeDefined();
      expect(fragment.services.helpers.slugify("Hello World")).toBe("hello-world");
      expect(fragment.services.helpers.capitalize("hello")).toBe("Hello");
    });

    test("providesService with 0-arity factory", () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const fragmentDef = defineFragmentWithDatabase("test-zero-arity")
        .withDatabase(testSchema)
        .providesService("constants", () => ({
          MAX_USERS: 100,
          MIN_PASSWORD_LENGTH: 8,
        }));

      const options: FragnoPublicConfigWithDatabase = {
        databaseAdapter: mockDatabaseAdapter,
      };

      const fragment = createFragment(fragmentDef, {}, [], options);

      expect(fragment.services.constants).toBeDefined();
      expect(fragment.services.constants.MAX_USERS).toBe(100);
      expect(fragment.services.constants.MIN_PASSWORD_LENGTH).toBe(8);
    });

    test("chaining multiple provided services", () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const fragmentDef = defineFragmentWithDatabase("test-chaining")
        .withDatabase(testSchema)
        .providesService("logger", {
          log: (msg: string) => console.log(msg),
        })
        .providesService("validator", () => ({
          validate: (value: string) => value.length > 0,
        }))
        .providesService("formatter", () => ({
          format: (value: string) => value.trim(),
        }));

      const options: FragnoPublicConfigWithDatabase = {
        databaseAdapter: mockDatabaseAdapter,
      };

      const fragment = createFragment(fragmentDef, {}, [], options);

      expect(fragment.services.logger).toBeDefined();
      expect(fragment.services.validator).toBeDefined();
      expect(fragment.services.formatter).toBeDefined();
      expect(fragment.services.logger.log).toBeDefined();
      expect(fragment.services.validator.validate).toBeDefined();
      expect(fragment.services.formatter.format).toBeDefined();
    });

    test("providesServices that uses `this` without defineService should have correct this context", async () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const fragmentDef = defineFragmentWithDatabase("test-this-context")
        .withDatabase(testSchema)
        .providesService(() => ({
          doThing: function () {
            // oxlint-disable-next-line no-explicit-any
            const uow = (this as any).getUnitOfWork();
            return { hasUow: !!uow };
          },
        }));

      const fragment = createFragment(fragmentDef, {}, [], {
        databaseAdapter: mockDatabaseAdapter,
      });

      expect(() => {
        fragment.services.doThing();
      }).toThrow(
        "No UnitOfWork in context. Service must be called within a route handler OR using `withUnitOfWork`.",
      );

      // Test implicit dependencies - withUnitOfWork is automatically available
      const { hasUow } = fragment.deps.withUnitOfWork(() => {
        return fragment.services.doThing();
      });

      expect(hasUow).toBe(true);
    });

    test("implicit dependencies are automatically available", () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const fragmentDef = defineFragmentWithDatabase("test-implicit-deps").withDatabase(testSchema);

      const fragment = createFragment(fragmentDef, {}, [], {
        databaseAdapter: mockDatabaseAdapter,
      });

      // All implicit dependencies should be available
      expect(fragment.deps.createUnitOfWork).toBeDefined();
      expect(fragment.deps.db).toBeDefined();
      expect(fragment.deps.withUnitOfWork).toBeDefined();

      // Verify types
      expectTypeOf(fragment.deps.createUnitOfWork).toBeFunction();
      expectTypeOf(fragment.deps.db).toExtend<AbstractQuery<typeof testSchema>>();
      expectTypeOf(fragment.deps.withUnitOfWork).toBeFunction();
    });

    test("withUnitOfWork supports both sync and async callbacks", async () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const fragmentDef = defineFragmentWithDatabase("test-sync-async").withDatabase(testSchema);

      const fragment = createFragment(fragmentDef, {}, [], {
        databaseAdapter: mockDatabaseAdapter,
      });

      // Test synchronous callback
      const syncResult = fragment.deps.withUnitOfWork(() => {
        return "sync-value";
      });
      expect(syncResult).toBe("sync-value");

      // Test asynchronous callback
      const asyncResult = await fragment.deps.withUnitOfWork(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return "async-value";
      });
      expect(asyncResult).toBe("async-value");
    });
  });

  describe("usesService", () => {
    test("should declare required service", () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      interface IEmailService {
        sendEmail(to: string, subject: string): Promise<void>;
      }

      const fragment = defineFragmentWithDatabase("test-uses-service")
        .withDatabase(testSchema)
        .usesService<"email", IEmailService>("email");

      expect(fragment.definition.usedServices).toBeDefined();
      expect(fragment.definition.usedServices?.email).toEqual({ name: "email", required: true });
    });

    test("should declare optional service", () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      interface ILogger {
        log(message: string): void;
      }

      const fragment = defineFragmentWithDatabase("test-optional-service")
        .withDatabase(testSchema)
        .usesService<"logger", ILogger>("logger", { optional: true });

      expect(fragment.definition.usedServices).toBeDefined();
      expect(fragment.definition.usedServices?.logger).toEqual({ name: "logger", required: false });
    });

    test("should throw when required service not provided", () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      interface IEmailService {
        sendEmail(to: string, subject: string): Promise<void>;
      }

      const fragment = defineFragmentWithDatabase("test-required")
        .withDatabase(testSchema)
        .usesService<"email", IEmailService>("email");

      const options: FragnoPublicConfigWithDatabase = {
        databaseAdapter: mockDatabaseAdapter,
      };

      expect(() => {
        createFragment(fragment, {}, [], options);
      }).toThrow("Fragment 'test-required' requires service 'email' but it was not provided");
    });

    test("should not throw when optional service not provided", () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      interface ILogger {
        log(message: string): void;
      }

      const fragment = defineFragmentWithDatabase("test-optional")
        .withDatabase(testSchema)
        .usesService<"logger", ILogger>("logger", { optional: true });

      const options: FragnoPublicConfigWithDatabase = {
        databaseAdapter: mockDatabaseAdapter,
      };

      expect(() => {
        createFragment(fragment, {}, [], options);
      }).not.toThrow();
    });

    test("provided service can access used services", () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      interface IEmailService {
        sendEmail(to: string, subject: string): Promise<void>;
      }

      const emailImpl: IEmailService = {
        sendEmail: async () => {},
      };

      const fragment = defineFragmentWithDatabase("test-deps")
        .withDatabase(testSchema)
        .usesService<"email", IEmailService>("email")
        .providesService(({ deps }) => ({
          notifyUser: async (userId: string) => {
            await deps.email.sendEmail(userId, "Notification");
          },
        }));

      const options: FragnoPublicConfigWithDatabase = {
        databaseAdapter: mockDatabaseAdapter,
      };

      const instance = createFragment(fragment, {}, [], options, { email: emailImpl });

      expect(instance.services.notifyUser).toBeDefined();
      expect(typeof instance.services.notifyUser).toBe("function");
    });
  });

  describe("Middleware with database fragments", () => {
    test("middleware works with database fragments", async () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const fragmentDef = defineFragmentWithDatabase("test-middleware")
        .withDatabase(testSchema)
        .providesService(({ defineService }) =>
          defineService({
            auth: {
              isAuthorized: function (token?: string) {
                const uow = this.getUnitOfWork();
                expect(uow).toBeDefined();

                return token === "valid-token";
              },
            },
          }),
        );

      const routes = [
        defineRoute({
          method: "GET",
          path: "/protected",
          outputSchema: z.object({ message: z.string() }),
          handler: async (_ctx, { json }) => {
            return json({ message: "You accessed protected resource" });
          },
        }),
      ] as const;

      const options: FragnoPublicConfigWithDatabase = {
        databaseAdapter: mockDatabaseAdapter,
        mountRoute: "/api",
      };

      const instance = createFragment(fragmentDef, {}, routes, options).withMiddleware(
        async ({ queryParams }, { services, error }) => {
          const token = queryParams.get("token");

          if (services.auth.isAuthorized(token ?? undefined)) {
            return undefined;
          }

          return error({ message: "Unauthorized", code: "UNAUTHORIZED" }, 401);
        },
      );

      // Test unauthorized request
      const unauthorizedReq = new Request("http://localhost/api/protected", {
        method: "GET",
      });
      const unauthorizedRes = await instance.handler(unauthorizedReq);
      expect(unauthorizedRes.status).toBe(401);
      const unauthorizedBody = await unauthorizedRes.json();
      expect(unauthorizedBody).toEqual({
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });

      // Test authorized request
      const authorizedReq = new Request("http://localhost/api/protected?token=valid-token", {
        method: "GET",
      });
      const authorizedRes = await instance.handler(authorizedReq);
      expect(authorizedRes.status).toBe(200);
      const authorizedBody = await authorizedRes.json();
      expect(authorizedBody).toEqual({
        message: "You accessed protected resource",
      });
    });

    test("callRoute creates UnitOfWork for database fragments", async () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const fragmentDef = defineFragmentWithDatabase("test-callroute").withDatabase(testSchema);

      const routesFactory = defineRoutes(fragmentDef).create(({ defineRoute }) => {
        return [
          defineRoute({
            method: "GET",
            path: "/users/:id",
            outputSchema: z.object({ id: z.string(), name: z.string() }),
            handler: async function (ctx, { json }) {
              // Handler should have access to UnitOfWork when called via callRoute
              const uow = this.getUnitOfWork();
              expect(uow).toBeDefined();

              return json({ id: ctx.pathParams.id, name: "Test User" });
            },
          }),
        ] as const;
      });

      const options: FragnoPublicConfigWithDatabase = {
        databaseAdapter: mockDatabaseAdapter,
        mountRoute: "/api",
      };

      const instance = createFragment(fragmentDef, {}, [routesFactory], options);

      // Test callRoute
      const response = await instance.callRoute("GET", "/users/:id", {
        pathParams: { id: "123" },
      });

      expect(response.type).toBe("json");
      expect(response.status).toBe(200);
      assert(response.type === "json");
      expect(response.data).toEqual({ id: "123", name: "Test User" });
    });
  });

  describe("FragmentInstantiationBuilder with database fragments", () => {
    test("works with database fragments using builder API", () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const fragmentDef = defineFragmentWithDatabase("test-builder")
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

      const fragment = instantiateFragment(fragmentDef)
        .withConfig({})
        .withOptions({ databaseAdapter: mockDatabaseAdapter })
        .build();

      expect(fragment.config.name).toBe("test-builder");
      expect(fragment.deps).toHaveProperty("userService");
      expect(fragment.services).toHaveProperty("logger");
    });

    test("builder works with routes and database adapter", () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      const fragmentDef = defineFragmentWithDatabase("test-routes")
        .withDatabase(testSchema)
        .providesService(({ db }) => ({
          getUserById: (id: string) =>
            db.findFirst("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", id))),
        }));

      const route = defineRoute({
        method: "GET",
        path: "/users",
        outputSchema: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
          }),
        ),
        handler: async (_ctx, { json }) => json([]),
      });

      const fragment = instantiateFragment(fragmentDef)
        .withConfig({})
        .withRoutes([route])
        .withOptions({ databaseAdapter: mockDatabaseAdapter })
        .build();

      expect(fragment.config.name).toBe("test-routes");
      expect(fragment.services).toHaveProperty("getUserById");
      expect(fragment.config.routes).toHaveLength(1);
      expect(fragment.config.routes[0].path).toBe("/users");
    });

    test("builder works with used services in database fragments", () => {
      const testSchema = schema((s) =>
        s.addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("name", column("string")),
        ),
      );

      interface IEmailService {
        sendEmail(to: string, subject: string): Promise<void>;
      }

      const emailImpl: IEmailService = {
        sendEmail: async () => {},
      };

      const fragmentDef = defineFragmentWithDatabase("test-services")
        .withDatabase(testSchema)
        .usesService<"email", IEmailService>("email")
        .providesService(({ deps }) => ({
          notifyUser: async (userId: string) => {
            await deps.email.sendEmail(userId, "Notification");
          },
        }));

      const fragment = instantiateFragment(fragmentDef)
        .withConfig({})
        .withOptions({ databaseAdapter: mockDatabaseAdapter })
        .withServices({ email: emailImpl })
        .build();

      expect(fragment.services.notifyUser).toBeDefined();
      expect(fragment.services.email).toBeDefined();
    });
  });
});
