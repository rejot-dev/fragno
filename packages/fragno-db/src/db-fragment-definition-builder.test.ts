import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { describe, it, expect, vi, expectTypeOf } from "vitest";
import { defineFragment } from "@fragno-dev/core";
import {
  DatabaseFragmentDefinitionBuilder,
  type ImplicitDatabaseDependencies,
} from "./db-fragment-definition-builder";
import { withDatabase } from "./with-database";
import { schema, column, idColumn } from "./schema/create";
import type { SimpleQueryInterface } from "./query/simple-query-interface";
import type { DatabaseAdapter } from "./adapters/adapters";
import * as executeUnitOfWork from "./query/unit-of-work/execute-unit-of-work";
import { RequestContextStorage } from "@fragno-dev/core/internal/request-context-storage";
import { suffixNamingStrategy, sanitizeNamespace } from "./naming/sql-naming";
import { SqlAdapter } from "./adapters/generic-sql/generic-sql-adapter";
import { BetterSQLite3DriverConfig } from "./adapters/generic-sql/driver-config";
import { getInternalFragment, getRegistryForAdapterSync } from "./internal/adapter-registry";
import { defineSyncCommands } from "./sync/commands";
import * as hooks from "./hooks/hooks";
import type { IUnitOfWork } from "./query/unit-of-work/unit-of-work";
import { GLOBAL_SHARD_SENTINEL } from "./sharding";

// Create a test schema
const testSchema = schema("test", (s) => {
  return s.addTable("users", (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("name", column("string"))
      .addColumn("email", column("string"));
  });
});

type TestSchema = typeof testSchema;

// Mock database adapter
function createMockAdapter(): DatabaseAdapter & { __mockDb: SimpleQueryInterface<TestSchema> } {
  const mockdb = {
    createUnitOfWork: vi.fn(() => ({
      forSchema: vi.fn(),
      executeRetrieve: vi.fn(),
      executeMutations: vi.fn(),
      registerSchema: vi.fn(),
      reset: vi.fn(),
    })),
  } as unknown as SimpleQueryInterface<TestSchema>;

  const adapter = {
    createQueryEngine: vi.fn(() => mockdb),
    getSchemaVersion: vi.fn(async () => undefined),
    close: vi.fn(),
    contextStorage: new RequestContextStorage(),
    namingStrategy: suffixNamingStrategy,
  } as unknown as DatabaseAdapter & { __mockDb: SimpleQueryInterface<TestSchema> };
  adapter.__mockDb = mockdb;
  return adapter;
}

describe("DatabaseFragmentDefinitionBuilder", () => {
  describe("withDatabase helper", () => {
    it("should create a database fragment builder", () => {
      const baseBuilder = defineFragment("test-db-fragment");
      const dbBuilder = withDatabase(testSchema)(baseBuilder);

      expect(dbBuilder).toBeInstanceOf(DatabaseFragmentDefinitionBuilder);
    });

    it("should work with .extend() API", () => {
      const dbBuilder = defineFragment("test-db-fragment").extend(withDatabase(testSchema));

      expect(dbBuilder).toBeInstanceOf(DatabaseFragmentDefinitionBuilder);
    });

    it("should build with database-specific features", () => {
      const _definition = defineFragment("test-db-fragment")
        .withDependencies(() => ({ apiKey: "key" }))
        .build();

      // Convert to database builder
      const dbDefinition = withDatabase(testSchema)(defineFragment("test-db-fragment"))
        .withDependencies(() => ({
          apiKey: "key",
          customDep: "value",
        }))
        .build();

      expect(dbDefinition.dependencies).toBeDefined();
      expect(dbDefinition.createThisContext).toBeDefined();
    });
  });

  describe("extend() API ordering", () => {
    it("should extend before withDependencies", () => {
      const mockAdapter = createMockAdapter();

      const definition = defineFragment("test-frag")
        .extend(withDatabase(testSchema))
        .withDependencies(({ databaseAdapter }) => {
          expect(databaseAdapter).toBeDefined();
          return {
            customDep: "value",
          };
        })
        .build();

      const deps = definition.dependencies!({
        config: {},
        options: { databaseAdapter: mockAdapter },
      });

      expect(deps.customDep).toBe("value");
      expect(deps.databaseAdapter).toBeDefined();
      expect(deps.createUnitOfWork).toBeDefined();
      expect(deps.schema).toBeDefined();
    });

    it("should extend after withDependencies", () => {
      const mockAdapter = createMockAdapter();

      const definition = defineFragment("test-frag")
        .withDependencies(() => ({
          apiKey: "key123",
        }))
        .extend(withDatabase(testSchema))
        .build();

      const deps = definition.dependencies!({
        config: {},
        options: { databaseAdapter: mockAdapter },
      });

      expect(deps.apiKey).toBe("key123");
      expect(deps.databaseAdapter).toBeDefined();
      expect(deps.createUnitOfWork).toBeDefined();
      expect(deps.schema).toBeDefined();
    });

    it("should extend before providesService", () => {
      const mockAdapter = createMockAdapter();

      const definition = defineFragment("test-frag")
        .extend(withDatabase(testSchema))
        .providesService("users", ({ deps }) => {
          expect(deps.databaseAdapter).toBeDefined();
          return {
            list: () => "users list",
          };
        })
        .build();

      const deps = definition.dependencies!({
        config: {},
        options: { databaseAdapter: mockAdapter },
      });

      const userService = definition.namedServices!.users({
        config: {},
        options: { databaseAdapter: mockAdapter },
        deps,
        serviceDeps: {},
        privateServices: {},
        defineService: (svc) => svc,
      });

      expect(userService.list()).toBe("users list");
    });

    it("should extend after providesService", () => {
      const mockAdapter = createMockAdapter();

      const definition = defineFragment("test-frag")
        .providesService("basic", () => ({
          ping: () => "pong",
        }))
        .extend(withDatabase(testSchema))
        .providesService("users", ({ deps }) => {
          expect(deps.databaseAdapter).toBeDefined();
          return {
            list: () => "users list",
          };
        })
        .build();

      const deps = definition.dependencies!({
        config: {},
        options: { databaseAdapter: mockAdapter },
      });

      const basicService = definition.namedServices!.basic({
        config: {},
        options: { databaseAdapter: mockAdapter },
        deps,
        serviceDeps: {},
        privateServices: {},
        defineService: (svc) => svc,
      });

      const userService = definition.namedServices!.users({
        config: {},
        options: { databaseAdapter: mockAdapter },
        deps,
        serviceDeps: {},
        privateServices: {},
        defineService: (svc) => svc,
      });

      expect(basicService.ping()).toBe("pong");
      expect(userService.list()).toBe("users list");
    });

    it("should extend before usesService", () => {
      interface EmailService {
        send: (to: string) => void;
      }

      const definition = defineFragment("test-frag")
        .extend(withDatabase(testSchema))
        .usesService<"email", EmailService>("email")
        .build();

      expect(definition.serviceDependencies).toBeDefined();
      expect(definition.serviceDependencies!.email).toEqual({
        name: "email",
        required: true,
      });
    });

    it("should extend after usesService", () => {
      interface LogService {
        log: (msg: string) => void;
      }

      const definition = defineFragment("test-frag")
        .usesService<"logger", LogService>("logger")
        .extend(withDatabase(testSchema))
        .build();

      expect(definition.serviceDependencies).toBeDefined();
      expect(definition.serviceDependencies!.logger).toEqual({
        name: "logger",
        required: true,
      });
    });

    it("should extend before providesBaseService", () => {
      const mockAdapter = createMockAdapter();

      const definition = defineFragment("test-frag")
        .extend(withDatabase(testSchema))
        .providesBaseService(({ deps }) => {
          expect(deps.databaseAdapter).toBeDefined();
          return {
            healthCheck: () => "healthy",
          };
        })
        .build();

      const deps = definition.dependencies!({
        config: {},
        options: { databaseAdapter: mockAdapter },
      });

      const services = definition.baseServices!({
        config: {},
        options: { databaseAdapter: mockAdapter },
        deps,
        serviceDeps: {},
        privateServices: {},
        defineService: (svc) => svc,
      });

      expect(services.healthCheck()).toBe("healthy");
    });

    it("should extend after providesBaseService replaces previous base service", () => {
      const mockAdapter = createMockAdapter();

      const definition = defineFragment("test-frag")
        .providesBaseService(() => ({
          ping: () => "pong",
        }))
        .extend(withDatabase(testSchema))
        .providesBaseService(({ deps }) => {
          expect(deps.databaseAdapter).toBeDefined();
          return {
            status: () => "ok",
          };
        })
        .build();

      const deps = definition.dependencies!({
        config: {},
        options: { databaseAdapter: mockAdapter },
      });

      const services = definition.baseServices!({
        config: {},
        options: { databaseAdapter: mockAdapter },
        deps,
        serviceDeps: {},
        privateServices: {},
        defineService: (svc) => svc,
      });

      // Second providesBaseService replaces the first one
      expect(services.status()).toBe("ok");
      expect(services).not.toHaveProperty("ping");
    });

    it("should chain multiple operations after extend", () => {
      const mockAdapter = createMockAdapter();

      interface LogService {
        log: (msg: string) => void;
      }

      const definition = defineFragment("test-frag")
        .extend(withDatabase(testSchema))
        .withDependencies(({ databaseAdapter }) => {
          expect(databaseAdapter).toBeDefined();
          return {
            apiKey: "secret",
          };
        })
        .usesOptionalService<"logger", LogService>("logger")
        .providesBaseService(({ deps, serviceDeps }) => ({
          init: () => {
            if (serviceDeps.logger) {
              serviceDeps.logger.log(`Initialized with key: ${deps.apiKey}`);
            }
            return "initialized";
          },
        }))
        .providesService("data", ({ deps }) => {
          expect(deps.databaseAdapter).toBeDefined();
          return {
            fetch: () => `Fetching with ${deps.apiKey}`,
          };
        })
        .build();

      const logs: string[] = [];
      const deps = definition.dependencies!({
        config: {},
        options: { databaseAdapter: mockAdapter },
      });

      const services = definition.baseServices!({
        config: {},
        options: { databaseAdapter: mockAdapter },
        deps,
        serviceDeps: {
          logger: {
            log: (msg) => logs.push(msg),
          },
        },
        privateServices: {},
        defineService: (svc) => svc,
      });

      expect(services.init()).toBe("initialized");
      expect(logs).toContain("Initialized with key: secret");

      const dataService = definition.namedServices!.data({
        config: {},
        options: { databaseAdapter: mockAdapter },
        deps,
        serviceDeps: {
          logger: {
            log: (msg) => logs.push(msg),
          },
        },
        privateServices: {},
        defineService: (svc) => svc,
      });

      expect(dataService.fetch()).toBe("Fetching with secret");
    });

    it("should support complex ordering: deps -> extend -> deps replaces previous", () => {
      const mockAdapter = createMockAdapter();

      const definition = defineFragment("test-frag")
        .withDependencies(() => ({
          baseConfig: "config1",
        }))
        .extend(withDatabase(testSchema))
        .withDependencies(({ databaseAdapter }) => {
          expect(databaseAdapter).toBeDefined();
          // Second withDependencies replaces the first one
          return {
            enhancedConfig: "enhanced",
          };
        })
        .providesService("combined", ({ deps }) => {
          expect(deps.databaseAdapter).toBeDefined();
          return {
            getConfig: () => deps.enhancedConfig,
          };
        })
        .build();

      const deps = definition.dependencies!({
        config: {},
        options: { databaseAdapter: mockAdapter },
      });

      // Only the second withDependencies is used (plus implicit deps)
      expect(deps).not.toHaveProperty("baseConfig");
      expect(deps.enhancedConfig).toBe("enhanced");
      expect(deps.databaseAdapter).toBeDefined();

      const combinedService = definition.namedServices!.combined({
        config: {},
        options: { databaseAdapter: mockAdapter },
        deps,
        serviceDeps: {},
        privateServices: {},
        defineService: (svc) => svc,
      });

      expect(combinedService.getConfig()).toBe("enhanced");
    });

    it("should preserve type safety with typed config across extend", () => {
      interface MyConfig {
        dbUrl: string;
        timeout: number;
      }

      const mockAdapter = createMockAdapter();

      const definition = defineFragment<MyConfig>("test-frag")
        .withDependencies(({ config }) => {
          expectTypeOf(config).toExtend<MyConfig>();
          return {
            connectionTimeout: config.timeout,
          };
        })
        .extend(withDatabase(testSchema))
        .withDependencies(({ config, databaseAdapter }) => {
          expectTypeOf(config).toExtend<MyConfig>();
          expect(databaseAdapter).toBeDefined();
          // Second withDependencies replaces the first, so combine them here
          return {
            connectionTimeout: config.timeout,
            dbConnectionString: config.dbUrl,
          };
        })
        .build();

      const deps = definition.dependencies!({
        config: { dbUrl: "postgres://localhost", timeout: 5000 },
        options: { databaseAdapter: mockAdapter },
      });

      expect(deps.connectionTimeout).toBe(5000);
      expect(deps.dbConnectionString).toBe("postgres://localhost");
      expect(deps.databaseAdapter).toBeDefined();
    });

    it("recommended pattern: extend first then configure", () => {
      const mockAdapter = createMockAdapter();

      interface LogService {
        log: (msg: string) => void;
      }

      interface AuthService {
        checkAuth: (token: string) => boolean;
      }

      // Best practice: .extend() early, then add all your features
      const definition = defineFragment("best-practice")
        .extend(withDatabase(testSchema))
        .withDependencies(({ databaseAdapter }) => {
          expect(databaseAdapter).toBeDefined();
          return {
            apiKey: "secret",
            timeout: 5000,
          };
        })
        .usesService<"logger", LogService>("logger")
        .usesOptionalService<"auth", AuthService>("auth")
        .providesBaseService(({ deps }) => ({
          healthCheck: () => {
            expect(deps.databaseAdapter).toBeDefined();
            return `OK (timeout: ${deps.timeout})`;
          },
        }))
        .providesService("users", ({ deps, serviceDeps }) => ({
          list: () => {
            if (serviceDeps.logger) {
              serviceDeps.logger.log("Listing users");
            }
            return `Users (key: ${deps.apiKey})`;
          },
        }))
        .build();

      const logs: string[] = [];
      const deps = definition.dependencies!({
        config: {},
        options: { databaseAdapter: mockAdapter },
      });

      // Verify all dependencies including implicit ones
      expect(deps.apiKey).toBe("secret");
      expect(deps.timeout).toBe(5000);
      expect(deps.databaseAdapter).toBeDefined();
      expect(deps.schema).toBeDefined();
      expect(deps.createUnitOfWork).toBeDefined();

      const baseServices = definition.baseServices!({
        config: {},
        options: { databaseAdapter: mockAdapter },
        deps,
        serviceDeps: {
          logger: { log: (msg) => logs.push(msg) },
          auth: undefined, // Optional service
        },
        privateServices: {},
        defineService: (svc) => svc,
      });

      expect(baseServices.healthCheck()).toBe("OK (timeout: 5000)");

      const userService = definition.namedServices!.users({
        config: {},
        options: { databaseAdapter: mockAdapter },
        deps,
        serviceDeps: {
          logger: { log: (msg) => logs.push(msg) },
          auth: undefined, // Optional service
        },
        privateServices: {},
        defineService: (svc) => svc,
      });

      expect(userService.list()).toBe("Users (key: secret)");
      expect(logs).toContain("Listing users");
    });
  });

  describe("withDependencies", () => {
    it("should inject database context into dependencies", () => {
      const mockAdapter = createMockAdapter();

      const definition = withDatabase(testSchema)(defineFragment("db-frag"))
        .withDependencies(({ databaseAdapter }) => {
          expect(databaseAdapter).toBeDefined();
          return {
            customDep: "test",
          };
        })
        .build();

      expect(definition.dependencies).toBeDefined();

      // Call dependencies with mock adapter
      const deps = definition.dependencies!({
        config: {},
        options: { databaseAdapter: mockAdapter },
      });

      // Should have implicit deps
      expect(deps).toHaveProperty("databaseAdapter");
      expect(deps).toHaveProperty("schema");
      expect(deps).toHaveProperty("createUnitOfWork");
      expect(deps).toHaveProperty("customDep");
      expect(deps.customDep).toBe("test");
    });

    it("should provide implicit database dependencies", () => {
      const mockAdapter = createMockAdapter();

      const definition = withDatabase(testSchema)(defineFragment("db-frag")).build();

      // Even without explicit dependencies, should add implicit ones
      expect(definition.dependencies).toBeDefined();

      const deps = definition.dependencies!({
        config: {},
        options: { databaseAdapter: mockAdapter },
      });

      // Check implicit dependencies structure
      expect(deps.databaseAdapter).toBeDefined();
      expect(deps.schema).toBeDefined();
      expect(typeof deps.createUnitOfWork).toBe("function");
    });
  });

  describe("sharding strategy registry", () => {
    it("reuses the adapter sharding strategy for internal fragments", () => {
      const mockAdapter = createMockAdapter();
      const registry = getRegistryForAdapterSync(mockAdapter);

      registry.registerShardingStrategy({ mode: "row" });

      const internalFragment = getInternalFragment(mockAdapter);
      expect(internalFragment.$internal.options.shardingStrategy).toEqual({ mode: "row" });
      expect(registry.internalFragment.$internal.options.shardingStrategy).toEqual({ mode: "row" });
    });

    it("throws when registering mismatched sharding strategies for the same adapter", () => {
      const mockAdapter = createMockAdapter();
      const registry = getRegistryForAdapterSync(mockAdapter);

      registry.registerShardingStrategy({ mode: "adapter", identifier: "primary" });

      expect(() =>
        registry.registerShardingStrategy({ mode: "adapter", identifier: "secondary" }),
      ).toThrowError(/Sharding strategy already registered/i);
    });

    it("uses adapter-level sharding strategy when fragment omits it", () => {
      const mockAdapter = createMockAdapter();
      const strategy = { mode: "row" } as const;

      const withStrategy = withDatabase(testSchema)(defineFragment("frag-with-strategy")).build();
      withStrategy.dependencies!({
        config: {},
        options: { databaseAdapter: mockAdapter, shardingStrategy: strategy },
      });

      const withoutStrategy = withDatabase(testSchema)(
        defineFragment("frag-without-strategy"),
      ).build();
      const deps = withoutStrategy.dependencies!({
        config: {},
        options: { databaseAdapter: mockAdapter },
      });

      const mockDb = mockAdapter.__mockDb as unknown as {
        createUnitOfWork: ReturnType<typeof vi.fn>;
      };
      const callCount = mockDb.createUnitOfWork.mock.calls.length;
      deps.createUnitOfWork();
      const call = mockDb.createUnitOfWork.mock.calls[callCount];

      expect(call?.[1]?.shardingStrategy).toEqual(strategy);
    });
  });

  describe("providesBaseService", () => {
    it("should inject database context into base services", () => {
      const mockAdapter = createMockAdapter();

      const definition = withDatabase(testSchema)(defineFragment("db-frag"))
        .withDependencies(() => ({ apiKey: "key" }))
        .providesBaseService(({ deps, defineService }) => {
          expect(deps.apiKey).toBe("key");
          expect(deps.databaseAdapter).toBeDefined();
          expect(defineService).toBeDefined();

          return defineService({
            getUsers: function () {
              return "users";
            },
          });
        })
        .build();

      expect(definition.baseServices).toBeDefined();

      // Get implicit deps first
      const deps = definition.dependencies!({
        config: {},
        options: { databaseAdapter: mockAdapter },
      });

      const services = definition.baseServices!({
        config: {},
        options: { databaseAdapter: mockAdapter },
        deps,
        serviceDeps: {},
        privateServices: {},
        defineService: (svc) => svc,
      });

      expect(services.getUsers()).toBe("users");
    });
  });

  describe("providesService", () => {
    it("should inject database context into named services", () => {
      const mockAdapter = createMockAdapter();

      const definition = withDatabase(testSchema)(defineFragment("db-frag"))
        .withDependencies(() => ({ apiKey: "key" }))
        .providesService("users", ({ deps }) => ({
          list: () => `Listing users with ${deps.apiKey}`,
          create: (name: string) => `Creating user ${name}`,
        }))
        .build();

      expect(definition.namedServices).toBeDefined();
      expect(definition.namedServices!.users).toBeDefined();

      // Get implicit deps
      const deps = definition.dependencies!({
        config: {},
        options: { databaseAdapter: mockAdapter },
      });

      const userService = definition.namedServices!.users({
        config: {},
        options: { databaseAdapter: mockAdapter },
        deps,
        serviceDeps: {},
        privateServices: {},
        defineService: (svc) => svc,
      });

      expect(userService.list()).toBe("Listing users with key");
      expect(userService.create("John")).toBe("Creating user John");
    });
  });

  describe("usesService", () => {
    it("should delegate service dependencies to base builder", () => {
      interface EmailService {
        send: (to: string) => void;
      }

      const definition = withDatabase(testSchema)(defineFragment("db-frag"))
        .usesService<"email", EmailService>("email")
        .build();

      expect(definition.serviceDependencies).toBeDefined();
      expect(definition.serviceDependencies!.email).toEqual({
        name: "email",
        required: true,
      });
    });

    it("should support optional service dependencies", () => {
      interface LogService {
        log: (msg: string) => void;
      }

      const definition = withDatabase(testSchema)(defineFragment("db-frag"))
        .usesOptionalService<"logger", LogService>("logger")
        .build();

      expect(definition.serviceDependencies!.logger.required).toBe(false);
    });
  });

  describe("withSyncCommands", () => {
    it("registers sync commands in adapter registry", async () => {
      const sqlite = new SQLite(":memory:");
      const adapter = new SqlAdapter({
        dialect: new SqliteDialect({ database: sqlite }),
        driverConfig: new BetterSQLite3DriverConfig(),
      });

      const registry = getRegistryForAdapterSync(adapter);
      const syncCommands = defineSyncCommands({ schema: testSchema }).create(
        ({ defineCommand }) => [
          defineCommand({
            name: "ping",
            handler: async () => undefined,
          }),
        ],
      );

      const definition = defineFragment("sync-frag")
        .extend(withDatabase(testSchema))
        .withSyncCommands(syncCommands)
        .build();

      definition.dependencies!({
        config: {},
        options: { databaseAdapter: adapter },
      });

      const resolved = registry.resolveSyncCommand("sync-frag", testSchema.name, "ping");
      expect(resolved?.command).toBe(syncCommands.commands.get("ping"));
      expect(resolved?.namespace).toBe(sanitizeNamespace(testSchema.name));

      await adapter.close();
      sqlite.close();
    });
  });

  describe("createRequestStorage and createThisContext", () => {
    it("should create request storage with UnitOfWork", () => {
      const mockAdapter = createMockAdapter();

      const definition = withDatabase(testSchema)(defineFragment("db-frag")).build();

      expect(definition.createRequestStorage).toBeDefined();
      expect(definition.createThisContext).toBeDefined();

      // Create storage
      const storage = definition.createRequestStorage!({
        config: {},
        options: { databaseAdapter: mockAdapter },
        deps: {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      });

      expect(storage).toBeDefined();
      expect(storage.uow).toBeDefined();
      expect(storage.shard).toBeNull();
      expect(storage.shardScope).toBe("scoped");
    });

    it("should provide DatabaseServiceContext with serviceTx and DatabaseHandlerContext with handlerTx", () => {
      const mockAdapter = createMockAdapter();

      const definition = withDatabase(testSchema)(defineFragment("db-frag")).build();

      // Create a mock storage
      const mockStorage = {
        getStore: () => ({
          uow: mockAdapter.createQueryEngine(testSchema, "test").createUnitOfWork(),
          shard: null,
          shardScope: "scoped",
        }),
      } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

      const contexts = definition.createThisContext!({
        config: {},
        options: { databaseAdapter: mockAdapter },
        deps: {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        storage: mockStorage,
      });

      expect(typeof contexts.serviceContext.serviceTx).toBe("function");
      expect(typeof contexts.handlerContext.handlerTx).toBe("function");
    });

    it("should expose shard context helpers via implicit deps and handler/service contexts", () => {
      const mockAdapter = createMockAdapter();

      const definition = withDatabase(testSchema)(defineFragment("db-frag")).build();

      const deps = definition.dependencies!({
        config: {},
        options: { databaseAdapter: mockAdapter },
      });

      const storage = definition.createRequestStorage!({
        config: {},
        options: { databaseAdapter: mockAdapter },
        deps,
      });

      const contexts = definition.createThisContext!({
        config: {},
        options: { databaseAdapter: mockAdapter },
        deps,
        storage: mockAdapter.contextStorage,
      });

      mockAdapter.contextStorage.run(storage, () => {
        expect(deps.shardContext.get()).toBeNull();
        deps.shardContext.set("tenant_1");
        expect(deps.shardContext.get()).toBe("tenant_1");

        deps.shardContext.setScope("global");
        expect(deps.shardContext.getScope()).toBe("global");

        deps.shardContext.with("tenant_2", () => {
          expect(deps.shardContext.get()).toBe("tenant_2");
        });
        expect(deps.shardContext.get()).toBe("tenant_1");

        deps.shardContext.withScope("scoped", () => {
          expect(deps.shardContext.getScope()).toBe("scoped");
        });
        expect(deps.shardContext.getScope()).toBe("global");

        contexts.serviceContext.setShard("tenant_3");
        expect(contexts.handlerContext.getShard()).toBe("tenant_3");
        contexts.handlerContext.setShardScope("scoped");
        expect(contexts.serviceContext.getShardScope()).toBe("scoped");
      });
    });

    it("should restore shard context when callbacks throw synchronously", () => {
      const mockAdapter = createMockAdapter();

      const definition = withDatabase(testSchema)(defineFragment("db-frag")).build();

      const deps = definition.dependencies!({
        config: {},
        options: { databaseAdapter: mockAdapter },
      });

      const storage = definition.createRequestStorage!({
        config: {},
        options: { databaseAdapter: mockAdapter },
        deps,
      });

      mockAdapter.contextStorage.run(storage, () => {
        deps.shardContext.set("tenant_1");

        expect(() =>
          deps.shardContext.with("tenant_2", () => {
            throw new Error("boom");
          }),
        ).toThrowError("boom");

        expect(deps.shardContext.get()).toBe("tenant_1");

        deps.shardContext.setScope("global");
        expect(() =>
          deps.shardContext.withScope("scoped", () => {
            throw new Error("boom");
          }),
        ).toThrowError("boom");
        expect(deps.shardContext.getScope()).toBe("global");
      });
    });

    it("should validate shard values when setting shard context", () => {
      const mockAdapter = createMockAdapter();

      const definition = withDatabase(testSchema)(defineFragment("db-frag")).build();

      const deps = definition.dependencies!({
        config: {},
        options: { databaseAdapter: mockAdapter },
      });

      const storage = definition.createRequestStorage!({
        config: {},
        options: { databaseAdapter: mockAdapter },
        deps,
      });

      mockAdapter.contextStorage.run(storage, () => {
        expect(() => deps.shardContext.set("")).toThrowError(/non-empty/i);
        expect(() => deps.shardContext.set(GLOBAL_SHARD_SENTINEL)).toThrowError(/reserved/i);
        const tooLongShard = "a".repeat(65);
        expect(() => deps.shardContext.set(tooLongShard)).toThrowError(/at most 64/i);
      });
    });
  });

  describe("complex database fragment", () => {
    it("should support full database fragment definition", () => {
      interface Config {
        dbConnectionString: string;
        debug: boolean;
      }

      interface LogService {
        log: (msg: string) => void;
      }

      const mockAdapter = createMockAdapter();

      const definition = withDatabase(testSchema)(defineFragment<Config>("complex-db-frag"))
        .withDependencies(({ config }) => ({
          connectionString: config.dbConnectionString,
          debug: config.debug,
        }))
        .usesOptionalService<"logger", LogService>("logger")
        .providesBaseService(({ serviceDeps }) => ({
          healthCheck: () => {
            if (serviceDeps.logger) {
              serviceDeps.logger.log("Health check");
            }
            return "OK";
          },
        }))
        .providesService("users", () => ({
          getAll: () => "all users",
          create: (name: string) => `Created user ${name}`,
        }))
        .build();

      expect(definition.name).toBe("complex-db-frag");
      expect(definition.dependencies).toBeDefined();
      expect(definition.baseServices).toBeDefined();
      expect(definition.namedServices).toBeDefined();
      expect(definition.serviceDependencies).toBeDefined();
      expect(definition.createThisContext).toBeDefined();

      // Test execution
      const logs: string[] = [];
      const deps = definition.dependencies!({
        config: { dbConnectionString: "postgres://localhost", debug: true },
        options: { databaseAdapter: mockAdapter },
      });

      const services = definition.baseServices!({
        config: { dbConnectionString: "postgres://localhost", debug: true },
        options: { databaseAdapter: mockAdapter },
        deps,
        serviceDeps: {
          logger: {
            log: (msg) => logs.push(msg),
          },
        },
        privateServices: {},
        defineService: (svc) => svc,
      });

      expect(services.healthCheck()).toBe("OK");
      expect(logs).toContain("Health check");

      const userService = definition.namedServices!.users({
        config: { dbConnectionString: "postgres://localhost", debug: true },
        options: { databaseAdapter: mockAdapter },
        deps,
        serviceDeps: {
          logger: {
            log: (msg) => logs.push(msg),
          },
        },
        privateServices: {},
        defineService: (svc) => svc,
      });

      expect(userService.getAll()).toBe("all users");
      expect(userService.create("Alice")).toBe("Created user Alice");
    });
  });

  describe("default adapter", () => {
    it("should default to sqlite adapter when database adapter is missing", () => {
      const previous = process.env["FRAGNO_DATA_DIR"];
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fragno-db-default-"));
      process.env["FRAGNO_DATA_DIR"] = dataDir;

      const definition = withDatabase(testSchema)(defineFragment("db-frag")).build();

      try {
        const deps = definition.dependencies!({
          config: {},
          options: {},
        });

        expect(deps.databaseAdapter).toBeDefined();
        expect(deps.createUnitOfWork).toBeDefined();
      } finally {
        if (previous === undefined) {
          delete process.env["FRAGNO_DATA_DIR"];
        } else {
          process.env["FRAGNO_DATA_DIR"] = previous;
        }
      }
    });
  });

  describe("type inference", () => {
    it("should correctly infer implicit dependencies", () => {
      const mockAdapter = createMockAdapter();

      const definition = withDatabase(testSchema)(defineFragment("db-frag"))
        .withDependencies(() => ({
          customDep: "test",
        }))
        .build();

      const deps = definition.dependencies!({
        config: {},
        options: { databaseAdapter: mockAdapter },
      });

      expectTypeOf(deps).toExtend<
        {
          customDep: string;
        } & ImplicitDatabaseDependencies<TestSchema>
      >();

      expect(deps.customDep).toBe("test");
      expect(deps.databaseAdapter).toBeDefined();
    });
  });

  describe("serviceTx hooks propagation", () => {
    it("should pass hooks to createServiceTxBuilder", () => {
      const mockAdapter = createMockAdapter();

      // Define hooks type
      type TestHooks = {
        onUserCreated: (payload: { email: string }) => void;
      };

      // Create a fragment with hooks
      const definition = withDatabase(testSchema)(defineFragment("db-frag-with-hooks"))
        .provideHooks<TestHooks>(({ defineHook }) => ({
          onUserCreated: defineHook(function (payload: { email: string }) {
            // Hook implementation
            console.log("User created:", payload.email);
          }),
        }))
        .build();

      // Create a mock storage
      const mockStorage = {
        getStore: () => ({
          uow: mockAdapter.createQueryEngine(testSchema, "test").createUnitOfWork(),
          shard: null,
          shardScope: "scoped",
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      // Spy on createServiceTxBuilder
      const createServiceTxBuilderSpy = vi.spyOn(executeUnitOfWork, "createServiceTxBuilder");

      // Get the contexts which includes serviceTx
      const contexts = definition.createThisContext!({
        config: {},
        options: { databaseAdapter: mockAdapter },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        deps: {} as any,
        storage: mockStorage,
      });

      // Call serviceTx - this should pass hooks to createServiceTxBuilder
      contexts.serviceContext.serviceTx(testSchema);

      // Verify createServiceTxBuilder was called with 3 arguments (schema, uow, hooks)
      expect(createServiceTxBuilderSpy).toHaveBeenCalledOnce();
      const callArgs = createServiceTxBuilderSpy.mock.calls[0];
      expect(callArgs).toHaveLength(3);
      expect(callArgs[0]).toBe(testSchema); // schema
      expect(callArgs[1]).toBeDefined(); // uow
      expect(callArgs[2]).toBeDefined(); // hooks - this is what we're testing
      expect(callArgs[2]).toHaveProperty("onUserCreated");

      createServiceTxBuilderSpy.mockRestore();
    });
  });

  describe("handlerTx plan mode", () => {
    it("should suppress hook mutations in plan mode", () => {
      const mockAdapter = createMockAdapter();

      type TestHooks = {
        onUserCreated: (payload: { email: string }) => void;
      };

      const definition = withDatabase(testSchema)(defineFragment("db-frag-plan-mode"))
        .provideHooks<TestHooks>(({ defineHook }) => ({
          onUserCreated: defineHook(function () {
            // no-op
          }),
        }))
        .build();

      const mockStorage = {
        getStore: () => ({
          uow: mockAdapter.createQueryEngine(testSchema, "test").createUnitOfWork(),
          shard: null,
          shardScope: "scoped",
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const createHandlerTxBuilderSpy = vi
        .spyOn(executeUnitOfWork, "createHandlerTxBuilder")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockReturnValue({} as any);

      const prepareHookMutationsSpy = vi.spyOn(hooks, "prepareHookMutations");

      const contexts = definition.createThisContext!({
        config: {},
        options: { databaseAdapter: mockAdapter },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        deps: {} as any,
        storage: mockStorage,
      });

      contexts.handlerContext.handlerTx({ planMode: true });

      const callArgs = createHandlerTxBuilderSpy.mock.calls[0]?.[0];
      callArgs?.onBeforeMutate?.({} as unknown as IUnitOfWork);

      expect(prepareHookMutationsSpy).not.toHaveBeenCalled();

      prepareHookMutationsSpy.mockRestore();
      createHandlerTxBuilderSpy.mockRestore();
    });
  });
});
