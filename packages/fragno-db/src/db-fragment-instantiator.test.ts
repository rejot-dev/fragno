import { describe, it, expect, vi, assert } from "vitest";
import { instantiate } from "@fragno-dev/core/api/fragment-instantiator";
import { defineFragment } from "@fragno-dev/core/api/fragment-definition-builder";
import { defineRoutes } from "@fragno-dev/core/api/route";
import { withDatabase } from "./db-fragment-definition-builder";
import { schema, idColumn, column } from "./schema/create";
import type { DatabaseAdapter } from "./adapters/adapters";
import type { AbstractQuery } from "./query/query";
import { RequestContextStorage } from "@fragno-dev/core/api/request-context-storage";
import { z } from "zod";

// Create a test schema
const testSchema = schema((s) => {
  return s.addTable("users", (t) => {
    return t.addColumn("id", idColumn()).addColumn("name", column("string"));
  });
});

type TestSchema = typeof testSchema;

// Mock database adapter
function createMockAdapter(): DatabaseAdapter {
  const mockdb = {
    createUnitOfWork: vi.fn(() => ({
      forSchema: vi.fn((schema) => ({
        schema,
        table: vi.fn(() => ({
          findMany: vi.fn(),
        })),
      })),
      executeRetrieve: vi.fn(),
      executeMutations: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      table: vi.fn(() => ({
        findMany: vi.fn(),
      })),
    })),
    type: "mock",
  } as unknown as AbstractQuery<TestSchema>;

  return {
    createQueryEngine: vi.fn(() => mockdb),
    migrate: vi.fn(),
    close: vi.fn(),
    type: "mock",
    contextStorage: new RequestContextStorage(),
  } as unknown as DatabaseAdapter;
}

describe("db-fragment-instantiator", () => {
  describe("Unit of Work in request context", () => {
    it("should provide getUnitOfWork on this context in route handlers", async () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .build();

      const routes = defineRoutes(definition).create(({ defineRoute }) => [
        defineRoute({
          method: "GET",
          path: "/test",
          handler: async function (_input, { json }) {
            // Access getUnitOfWork from this context
            const uow = this.getUnitOfWork();
            expect(uow).toBeDefined();

            return json({ hasUow: !!uow });
          },
        }),
      ]);

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withRoutes([routes])
        .withOptions({ mountRoute: "/api", databaseAdapter: mockAdapter })
        .build();

      const response = await fragment.handler(new Request("http://localhost/api/test"));
      const data = await response.json();

      expect(data).toEqual({ hasUow: true });
    });

    it("should provide schema-typed UOW when schema is passed", async () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .build();

      const routes = defineRoutes(definition).create(({ defineRoute }) => [
        defineRoute({
          method: "GET",
          path: "/test",
          handler: async function (_input, { json }) {
            const uow = this.getUnitOfWork(testSchema);

            return json({ hasSchemaUow: !!uow });
          },
        }),
      ]);

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withRoutes([routes])
        .withOptions({ mountRoute: "/api", databaseAdapter: mockAdapter })
        .build();

      const response = await fragment.handler(new Request("http://localhost/api/test"));
      const data = await response.json();

      expect(data).toEqual({ hasSchemaUow: true });
    });
  });

  describe("implicit database dependencies", () => {
    it("should provide db dependency to services", () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .providesBaseService(({ deps }) => ({
          getDb: () => deps.db,
        }))
        .build();

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withOptions({ databaseAdapter: mockAdapter })
        .build();

      const db = fragment.services.getDb();
      expect(db).toBeDefined();
      expect(db.createUnitOfWork).toBeDefined();
    });

    it("should provide schema dependency to services", () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .providesBaseService(({ deps }) => ({
          getSchema: () => deps.schema,
        }))
        .build();

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withOptions({ databaseAdapter: mockAdapter })
        .build();

      const schemaFromService = fragment.services.getSchema();
      expect(schemaFromService).toBe(testSchema);
    });

    it("should provide createUnitOfWork dependency", () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .providesBaseService(({ deps }) => ({
          createUow: () => deps.createUnitOfWork(),
        }))
        .build();

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withOptions({ databaseAdapter: mockAdapter })
        .build();

      const uow = fragment.services.createUow();
      expect(uow).toBeDefined();
      expect(uow.executeRetrieve).toBeDefined();
      expect(uow.executeMutations).toBeDefined();
    });
  });

  describe("database operations with UOW", () => {
    it("should allow accessing schema-typed UOW in handlers", async () => {
      const testSchemaWithCounter = schema((s) => {
        return s.addTable("counters", (t) => {
          return t.addColumn("id", idColumn()).addColumn("value", column("integer"));
        });
      });

      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchemaWithCounter))
        .build();

      const routes = defineRoutes(definition).create(({ defineRoute }) => [
        defineRoute({
          method: "GET",
          path: "/counters",
          handler: async function (_input, { json }) {
            const uow = this.getUnitOfWork(testSchemaWithCounter);

            // Verify that we can access the UOW
            return json({ hasCountersTable: !!uow });
          },
        }),
      ]);

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withRoutes([routes])
        .withOptions({ mountRoute: "/api", databaseAdapter: mockAdapter })
        .build();

      const response = await fragment.handler(new Request("http://localhost/api/counters"));
      const data = await response.json();

      expect(data).toEqual({ hasCountersTable: true });
    });
  });

  describe("service integration with UOW", () => {
    it("should allow services to access UOW via this context", async () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .providesBaseService(({ defineService }) =>
          defineService({
            checkUowExists: function () {
              const uow = this.getUnitOfWork();
              return !!uow;
            },
            checkTypedUowExists: function () {
              const uow = this.getUnitOfWork(testSchema);
              return !!uow;
            },
          }),
        )
        .build();

      const routes = defineRoutes(definition).create(({ services, defineRoute }) => [
        defineRoute({
          method: "GET",
          path: "/check",
          outputSchema: z.object({ hasUow: z.boolean(), hasTypedUow: z.boolean() }),
          handler: async function (_input, { json }) {
            const hasUow = services.checkUowExists();
            const hasTypedUow = services.checkTypedUowExists();
            return json({ hasUow, hasTypedUow });
          },
        }),
      ]);

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withRoutes([routes])
        .withOptions({ mountRoute: "/api", databaseAdapter: mockAdapter })
        .build();

      const response = await fragment.callRoute("GET", "/check");
      expect(response.status).toBe(200);
      assert(response.type === "json");
      expect(response.data).toEqual({ hasUow: true, hasTypedUow: true });
    });

    it("should share same UOW across multiple service calls from handler", async () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .providesService("helpers", ({ defineService }) =>
          defineService({
            logUow: function () {
              return this.getUnitOfWork();
            },
          }),
        )
        .providesService("main", ({ defineService }) =>
          defineService({
            markUow: function () {
              return this.getUnitOfWork();
            },
          }),
        )
        .build();

      const routes = defineRoutes(definition).create(({ services, defineRoute }) => [
        defineRoute({
          method: "GET",
          path: "/nested",
          handler: async function (_input, { json }) {
            // Mark the UOW with an ID
            const uow1 = services.main.markUow();

            const uow2 = services.helpers.logUow();
            const uow3 = services.main.markUow();

            return json({
              same: uow1 === uow2 && uow2 === uow3,
            });
          },
        }),
      ]);

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withRoutes([routes])
        .withOptions({ mountRoute: "/api", databaseAdapter: mockAdapter })
        .build();

      const response = await fragment.handler(new Request("http://localhost/api/nested"));
      const data = await response.json();

      expect(data).toEqual({
        same: true,
      });
    });
  });

  describe("inContext with database fragments", () => {
    it("should allow calling services with UOW via inContext", () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .providesBaseService(({ defineService }) =>
          defineService({
            getUowExists: function () {
              const uow = this.getUnitOfWork();
              return !!uow;
            },
          }),
        )
        .build();

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withOptions({ databaseAdapter: mockAdapter })
        .build();

      const result = fragment.inContext(() => fragment.services.getUowExists());
      expect(result).toBe(true);
    });
  });

  describe("UOW isolation per request", () => {
    it("should create fresh UOW for each request", async () => {
      let createUowCallCount = 0;
      const mockAdapter = createMockAdapter();
      const queryEngine = mockAdapter.createQueryEngine(testSchema, "test");

      // Track how many times createUnitOfWork is called
      const originalCreateUow = queryEngine.createUnitOfWork;
      queryEngine.createUnitOfWork = vi.fn(() => {
        createUowCallCount++;
        return originalCreateUow();
      });

      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .build();

      const routes = defineRoutes(definition).create(({ defineRoute }) => [
        defineRoute({
          method: "GET",
          path: "/test",
          handler: async function (_input, { json }) {
            const uow = this.getUnitOfWork();
            return json({ hasUow: !!uow });
          },
        }),
      ]);

      const fragment = instantiate(definition)
        .withRoutes([routes])
        .withOptions({ mountRoute: "/api", databaseAdapter: mockAdapter })
        .build();

      // Make two requests
      await fragment.handler(new Request("http://localhost/api/test"));
      await fragment.handler(new Request("http://localhost/api/test"));

      // Verify that createUnitOfWork was called twice (once per request)
      expect(createUowCallCount).toBe(2);
      expect(queryEngine.createUnitOfWork).toHaveBeenCalledTimes(2);
    });
  });

  describe("withDependencies with database context", () => {
    it("should provide db and databaseAdapter in withDependencies context", () => {
      interface Config {
        prefix: string;
      }

      const definition = defineFragment<Config>("test-db-fragment")
        .extend(withDatabase(testSchema))
        .withDependencies(({ config, db, databaseAdapter }) => ({
          userService: {
            prefix: config.prefix,
            hasAdapter: !!databaseAdapter,
            hasDb: !!db,
          },
        }))
        .providesBaseService(({ deps }) => ({
          getUserServicePrefix: () => deps.userService.prefix,
          hasAdapter: () => deps.userService.hasAdapter,
          hasDb: () => deps.userService.hasDb,
        }))
        .build();

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withConfig({ prefix: "USER_" })
        .withOptions({ databaseAdapter: mockAdapter })
        .build();

      expect(fragment.services.getUserServicePrefix()).toBe("USER_");
      expect(fragment.services.hasAdapter()).toBe(true);
      expect(fragment.services.hasDb()).toBe(true);
    });
  });

  describe("error handling", () => {
    it("should throw when databaseAdapter is not provided", () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .build();

      expect(() => {
        instantiate(definition)
          // @ts-expect-error - Test case
          .withOptions({})
          .build();
      }).toThrow("Database fragment requires a database adapter");
    });

    it("should throw when getUnitOfWork called outside request context", () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .providesBaseService(({ defineService }) =>
          defineService({
            tryGetUow: function () {
              return this.getUnitOfWork();
            },
          }),
        )
        .build();

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withOptions({ databaseAdapter: mockAdapter })
        .build();

      expect(() => fragment.services.tryGetUow()).toThrow(
        "No storage found in RequestContextStorage. Service must be called within a route handler OR using `inContext`.",
      );
    });
  });
});
