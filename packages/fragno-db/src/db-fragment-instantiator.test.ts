import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, assert } from "vitest";
import { instantiate, defineFragment } from "@fragno-dev/core";
import { defineRoutes } from "@fragno-dev/core/route";
import { withDatabase } from "./with-database";
import { schema, idColumn, column } from "./schema/create";
import type { DatabaseAdapter } from "./adapters/adapters";
import type { SimpleQueryInterface } from "./query/simple-query-interface";
import { RequestContextStorage } from "@fragno-dev/core/internal/request-context-storage";
import { z } from "zod";
import { suffixNamingStrategy } from "./naming/sql-naming";

// Create a test schema
const testSchema = schema("test", (s) => {
  return s.addTable("users", (t) => {
    return t.addColumn("id", idColumn()).addColumn("name", column("string"));
  });
});

// Schema with dashes in the name (used to test namespace sanitization)
const dashedSchema = schema("my-fragment", (s) => {
  return s.addTable("items", (t) => {
    return t.addColumn("id", idColumn()).addColumn("label", column("string"));
  });
});

type TestSchema = typeof testSchema;

// Mock database adapter
function createMockAdapter(): DatabaseAdapter {
  const mockdb = {
    createUnitOfWork: vi.fn(() => {
      // Create a mock restricted UOW
      const createMockRestrictedUow = () => ({
        forSchema: vi.fn((schema) => ({
          schema,
          table: vi.fn(() => ({
            findMany: vi.fn(),
          })),
          restrict: vi.fn(() => createMockRestrictedUow()),
          signalReadyForRetrieval: vi.fn(),
          signalReadyForMutation: vi.fn(),
          retrievalPhase: Promise.resolve([]),
          mutationPhase: Promise.resolve(),
        })),
        restrict: vi.fn(() => createMockRestrictedUow()),
        getRetrievalOperations: vi.fn(() => []),
        getMutationOperations: vi.fn(() => []),
        table: vi.fn(() => ({
          findMany: vi.fn(),
        })),
        signalReadyForRetrieval: vi.fn(),
        signalReadyForMutation: vi.fn(),
        retrievalPhase: Promise.resolve([]),
        mutationPhase: Promise.resolve(),
      });

      return {
        forSchema: vi.fn((schema) => ({
          schema,
          table: vi.fn(() => ({
            findMany: vi.fn(),
          })),
          restrict: vi.fn(() => createMockRestrictedUow()),
          signalReadyForRetrieval: vi.fn(),
          signalReadyForMutation: vi.fn(),
          retrievalPhase: Promise.resolve([]),
          mutationPhase: Promise.resolve(),
        })),
        restrict: vi.fn(() => createMockRestrictedUow()),
        executeRetrieve: vi.fn(async () => {}),
        executeMutations: vi.fn(async () => ({ success: true })),
        commit: vi.fn(),
        rollback: vi.fn(),
        registerSchema: vi.fn(),
        reset: vi.fn(),
        getRetrievalOperations: vi.fn(() => []),
        getMutationOperations: vi.fn(() => []),
        getCreatedIds: vi.fn(() => []),
        table: vi.fn(() => ({
          findMany: vi.fn(),
        })),
        idempotencyKey: "test-nonce",
        state: "building-retrieval",
      };
    }),
    type: "mock",
  } as unknown as SimpleQueryInterface<TestSchema>;

  return {
    createQueryEngine: vi.fn(() => mockdb),
    getSchemaVersion: vi.fn(async () => undefined),
    close: vi.fn(),
    type: "mock",
    contextStorage: new RequestContextStorage(),
    namingStrategy: suffixNamingStrategy,
  } as unknown as DatabaseAdapter;
}

describe("db-fragment-instantiator", () => {
  describe("Unit of Work in request context", () => {
    it("should provide handlerTx on this context in route handlers", async () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .build();

      const routes = defineRoutes(definition).create(({ defineRoute }) => [
        defineRoute({
          method: "GET",
          path: "/test",
          handler: async function (_input, { json }) {
            // Access handlerTx from this context
            expect(this.handlerTx).toBeDefined();

            return json({ hasHandlerTxBuilder: !!this.handlerTx });
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

      expect(data).toEqual({ hasHandlerTxBuilder: true });
    });

    it("should provide schema-typed UOW via handlerTx", async () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .build();

      const routes = defineRoutes(definition).create(({ defineRoute }) => [
        defineRoute({
          method: "GET",
          path: "/test",
          handler: async function (_input, { json }) {
            const result = await this.handlerTx()
              .mutate(({ forSchema }) => {
                const uow = forSchema(testSchema);
                return { hasSchemaUow: !!uow };
              })
              .execute();

            return json(result);
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
    it("should provide databaseAdapter dependency to services", () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .providesBaseService(({ deps }) => ({
          getAdapter: () => deps.databaseAdapter,
        }))
        .build();

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withOptions({ databaseAdapter: mockAdapter })
        .build();

      const adapter = fragment.services.getAdapter();
      expect(adapter).toBe(mockAdapter);
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
    it("should allow accessing schema-typed UOW in handlers via handlerTx", async () => {
      const testSchemaWithCounter = schema("testschemawithcounter", (s) => {
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
            const result = await this.handlerTx()
              .mutate(({ forSchema }) => {
                const uow = forSchema(testSchemaWithCounter);
                // Verify that we can access the UOW
                return { hasCountersTable: !!uow };
              })
              .execute();

            return json(result);
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
    it("should allow services to access UOW via serviceTx", async () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .providesBaseService(({ defineService }) =>
          defineService({
            checkTypedUowExists: function () {
              return this.serviceTx(testSchema)
                .mutate(({ uow }) => !!uow)
                .build();
            },
          }),
        )
        .build();

      const routes = defineRoutes(definition).create(({ services, defineRoute }) => [
        defineRoute({
          method: "GET",
          path: "/check",
          outputSchema: z.object({ hasTypedUow: z.boolean() }),
          handler: async function (_input, { json }) {
            const hasTypedUow = await this.handlerTx()
              .withServiceCalls(() => [services.checkTypedUowExists()] as const)
              .transform(({ serviceResult: [result] }) => result)
              .execute();
            return json({ hasTypedUow });
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
      expect(response.data).toEqual({ hasTypedUow: true });
    });
  });

  describe("inContext with database fragments", () => {
    it("should allow calling services with UOW via inContext", async () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .providesBaseService(({ defineService }) =>
          defineService({
            getUowExists: function () {
              return this.serviceTx(testSchema)
                .mutate(({ uow }) => !!uow)
                .build();
            },
          }),
        )
        .build();

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withOptions({ databaseAdapter: mockAdapter })
        .build();

      const result = await fragment.callServices(() => fragment.services.getUowExists());
      expect(result).toBe(true);
    });

    it("should allow calling multiple services at once via callServices", async () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .providesBaseService(({ defineService }) =>
          defineService({
            getUowExists: function () {
              return this.serviceTx(testSchema)
                .mutate(({ uow }) => !!uow)
                .build();
            },
          }),
        )
        .build();

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withOptions({ databaseAdapter: mockAdapter })
        .build();

      const results = await fragment.callServices(
        () => [fragment.services.getUowExists(), fragment.services.getUowExists()] as const,
      );

      expect(results).toEqual([true, true]);
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
            const result = await this.handlerTx()
              .mutate(({ forSchema }) => {
                const uow = forSchema(testSchema);
                return { hasUow: !!uow };
              })
              .execute();
            return json(result);
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
    it("should provide databaseAdapter in withDependencies context", () => {
      interface Config {
        prefix: string;
      }

      const definition = defineFragment<Config>("test-db-fragment")
        .extend(withDatabase(testSchema))
        .withDependencies(({ config, databaseAdapter }) => ({
          userService: {
            prefix: config.prefix,
            hasAdapter: !!databaseAdapter,
          },
        }))
        .providesBaseService(({ deps }) => ({
          getUserServicePrefix: () => deps.userService.prefix,
          hasAdapter: () => deps.userService.hasAdapter,
        }))
        .build();

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withConfig({ prefix: "USER_" })
        .withOptions({ databaseAdapter: mockAdapter })
        .build();

      expect(fragment.services.getUserServicePrefix()).toBe("USER_");
      expect(fragment.services.hasAdapter()).toBe(true);
    });
  });

  describe("$internal object", () => {
    it("should populate $internal.deps with database dependencies", () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .build();

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withOptions({ mountRoute: "/api", databaseAdapter: mockAdapter })
        .build();

      expect(fragment.$internal.deps).toBeDefined();
      expect(fragment.$internal.deps).toHaveProperty("databaseAdapter");
      expect(fragment.$internal.deps).toHaveProperty("schema");
      expect(fragment.$internal.deps).toHaveProperty("namespace");
      expect(fragment.$internal.deps).toHaveProperty("createUnitOfWork");
    });

    it("should populate $internal.options with database adapter", () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .build();

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withOptions({ mountRoute: "/api", databaseAdapter: mockAdapter })
        .build();

      expect(fragment.$internal.options).toBeDefined();
      expect(fragment.$internal.options).toHaveProperty("databaseAdapter");
      expect(fragment.$internal.options.databaseAdapter).toBe(mockAdapter);
      expect(fragment.$internal.options).toHaveProperty("mountRoute", "/api");
    });

    it("should have correct schema and namespace in $internal.deps", () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .build();

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withOptions({ mountRoute: "/api", databaseAdapter: mockAdapter })
        .build();

      expect(fragment.$internal.deps.schema).toBe(testSchema);
      expect(fragment.$internal.deps.namespace).toBe("test");
    });

    it("should use databaseNamespace override when provided", () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .build();

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withOptions({
          mountRoute: "/api",
          databaseAdapter: mockAdapter,
          databaseNamespace: "custom-namespace",
        })
        .build();

      expect(fragment.$internal.deps.namespace).toBe("custom-namespace");
    });

    it("should allow explicit null namespace override", () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .build();

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withOptions({
          mountRoute: "/api",
          databaseAdapter: mockAdapter,
          databaseNamespace: null,
        })
        .build();

      expect(fragment.$internal.deps.namespace).toBeNull();
    });

    it("should sanitize dashes in schema.name when used as default namespace", () => {
      const definition = defineFragment("test-dashed-fragment")
        .extend(withDatabase(dashedSchema))
        .build();

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withOptions({ mountRoute: "/api", databaseAdapter: mockAdapter })
        .build();

      // schema.name is "my-fragment", but default namespace should be sanitized to "my_fragment"
      expect(fragment.$internal.deps.namespace).toBe("my_fragment");
    });

    it("should NOT sanitize explicit databaseNamespace even when it contains dashes", () => {
      const definition = defineFragment("test-dashed-fragment")
        .extend(withDatabase(dashedSchema))
        .build();

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withOptions({
          mountRoute: "/api",
          databaseAdapter: mockAdapter,
          databaseNamespace: "my-fragment",
        })
        .build();

      // Explicit override should be used as-is, dashes preserved
      expect(fragment.$internal.deps.namespace).toBe("my-fragment");
    });

    it("should populate $internal when using providesBaseService without withDependencies", () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .providesBaseService(({ defineService }) =>
          defineService({
            testMethod: function () {
              return "test";
            },
          }),
        )
        .build();

      const mockAdapter = createMockAdapter();
      const fragment = instantiate(definition)
        .withOptions({ mountRoute: "/api", databaseAdapter: mockAdapter })
        .build();

      expect(fragment.$internal.deps).toBeDefined();
      expect(fragment.$internal.deps).toHaveProperty("databaseAdapter");
      expect(fragment.$internal.deps).toHaveProperty("schema");
      expect(fragment.$internal.deps).toHaveProperty("namespace");
      expect(fragment.$internal.deps).toHaveProperty("createUnitOfWork");
      expect(fragment.$internal.options).toBeDefined();
      expect(fragment.$internal.options).toHaveProperty("databaseAdapter");
      expect(fragment.$internal.options.databaseAdapter).toBe(mockAdapter);
    });
  });

  describe("default adapter", () => {
    it("should default to sqlite adapter when databaseAdapter is not provided", () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .build();
      const previous = process.env["FRAGNO_DATA_DIR"];
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fragno-db-default-"));
      process.env["FRAGNO_DATA_DIR"] = dataDir;

      try {
        const fragment = instantiate(definition).withOptions({}).build();
        expect(fragment.$internal.options.databaseAdapter).toBeDefined();
        expect(fragment.$internal.deps.databaseAdapter).toBeDefined();
        expect(fragment.$internal.deps.createUnitOfWork).toBeDefined();
      } finally {
        if (previous === undefined) {
          delete process.env["FRAGNO_DATA_DIR"];
        } else {
          process.env["FRAGNO_DATA_DIR"] = previous;
        }
      }
    });

    it("should throw when serviceTx called outside request context", () => {
      const definition = defineFragment("test-db-fragment")
        .extend(withDatabase(testSchema))
        .providesBaseService(({ defineService }) =>
          defineService({
            tryGetUow: function () {
              return this.serviceTx(testSchema)
                .mutate(({ uow }) => uow)
                .build();
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
