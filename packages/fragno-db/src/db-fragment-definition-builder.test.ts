import { describe, it, expect, vi, expectTypeOf } from "vitest";
import { defineFragment } from "@fragno-dev/core";
import {
  DatabaseFragmentDefinitionBuilder,
  withDatabase,
  type ImplicitDatabaseDependencies,
} from "./db-fragment-definition-builder";
import { schema, column, idColumn } from "./schema/create";
import type { AbstractQuery } from "./query/query";
import type { DatabaseAdapter } from "./adapters/adapters";

// Create a test schema
const testSchema = schema((s) => {
  return s.addTable("users", (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("name", column("string"))
      .addColumn("email", column("string"));
  });
});

type TestSchema = typeof testSchema;

// Mock database adapter
function createMockAdapter(): DatabaseAdapter {
  const mockdb = {
    createUnitOfWork: vi.fn(() => ({
      forSchema: vi.fn(),
      executeRetrieve: vi.fn(),
      executeMutations: vi.fn(),
    })),
  } as unknown as AbstractQuery<TestSchema>;

  return {
    createQueryEngine: vi.fn(() => mockdb),
    migrate: vi.fn(),
    close: vi.fn(),
  } as unknown as DatabaseAdapter;
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
        .withDependencies(({ db }) => {
          expect(db).toBeDefined();
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
      expect(deps.db).toBeDefined();
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
      expect(deps.db).toBeDefined();
      expect(deps.schema).toBeDefined();
    });

    it("should extend before providesService", () => {
      const mockAdapter = createMockAdapter();

      const definition = defineFragment("test-frag")
        .extend(withDatabase(testSchema))
        .providesService("users", ({ deps }) => {
          expect(deps.db).toBeDefined();
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
          expect(deps.db).toBeDefined();
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
        defineService: (svc) => svc,
      });

      const userService = definition.namedServices!.users({
        config: {},
        options: { databaseAdapter: mockAdapter },
        deps,
        serviceDeps: {},
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
          expect(deps.db).toBeDefined();
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
          expect(deps.db).toBeDefined();
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
        .withDependencies(({ db }) => {
          expect(db).toBeDefined();
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
          expect(deps.db).toBeDefined();
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
        .withDependencies(({ db }) => {
          expect(db).toBeDefined();
          // Second withDependencies replaces the first one
          return {
            enhancedConfig: "enhanced",
          };
        })
        .providesService("combined", ({ deps }) => {
          expect(deps.db).toBeDefined();
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
      expect(deps.db).toBeDefined();

      const combinedService = definition.namedServices!.combined({
        config: {},
        options: { databaseAdapter: mockAdapter },
        deps,
        serviceDeps: {},
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
        .withDependencies(({ config, db }) => {
          expectTypeOf(config).toExtend<MyConfig>();
          expect(db).toBeDefined();
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
      expect(deps.db).toBeDefined();
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
        .withDependencies(({ db }) => {
          expect(db).toBeDefined();
          return {
            apiKey: "secret",
            timeout: 5000,
          };
        })
        .usesService<"logger", LogService>("logger")
        .usesOptionalService<"auth", AuthService>("auth")
        .providesBaseService(({ deps }) => ({
          healthCheck: () => {
            expect(deps.db).toBeDefined();
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
      expect(deps.db).toBeDefined();
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
        .withDependencies(({ db, databaseAdapter }) => {
          expect(db).toBeDefined();
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
      expect(deps).toHaveProperty("db");
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
      expect(deps.db).toBeDefined();
      expect(deps.schema).toBeDefined();
      expect(typeof deps.createUnitOfWork).toBe("function");
    });
  });

  describe("providesBaseService", () => {
    it("should inject database context into base services", () => {
      const mockAdapter = createMockAdapter();

      const definition = withDatabase(testSchema)(defineFragment("db-frag"))
        .withDependencies(() => ({ apiKey: "key" }))
        .providesBaseService(({ deps, defineService }) => {
          expect(deps.apiKey).toBe("key");
          expect(deps.db).toBeDefined();
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
    });

    it("should provide DatabaseServiceContext with forSchema and DatabaseHandlerContext with executeRestrictedUnitOfWork", () => {
      const mockAdapter = createMockAdapter();

      const definition = withDatabase(testSchema)(defineFragment("db-frag")).build();

      // Create a mock storage
      const mockStorage = {
        getStore: () => ({
          uow: mockAdapter.createQueryEngine(testSchema, "test").createUnitOfWork(),
        }),
      } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

      const contexts = definition.createThisContext!({
        config: {},
        options: { databaseAdapter: mockAdapter },
        deps: {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        storage: mockStorage,
      });

      expect(typeof contexts.serviceContext.uow).toBe("function");
      expect(typeof contexts.handlerContext.uow).toBe("function");
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

      const definition = withDatabase(
        testSchema,
        "my-namespace",
      )(defineFragment<Config>("complex-db-frag"))
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
        defineService: (svc) => svc,
      });

      expect(userService.getAll()).toBe("all users");
      expect(userService.create("Alice")).toBe("Created user Alice");
    });
  });

  describe("error handling", () => {
    it("should throw error if database adapter is missing", () => {
      const definition = withDatabase(testSchema)(defineFragment("db-frag")).build();

      expect(() => {
        definition.dependencies!({
          config: {},
          // @ts-expect-error No databaseAdapter - intentionally invalid for runtime error test
          options: {},
        });
      }).toThrow("Database fragment requires a database adapter");
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
      expect(deps.db).toBeDefined();
    });
  });

  // describe("defineService", () => {
  //   it("getUnitOfWork should be available in defineService", () => {
  //     const mockAdapter = createMockAdapter();

  //     const definition = withDatabase(testSchema)(defineFragment("db-frag"))
  //       .withDependencies(() => ({ apiKey: "key" }))
  //       .providesBaseService(({ deps, defineService }) => {
  //         expect(deps.apiKey).toBe("key");
  //         expect(deps.db).toBeDefined();
  //         expect(defineService).toBeDefined();

  //         return defineService({
  //           getUsers: function () {
  //             return typeof this.getUnitOfWork;
  //           },
  //         });
  //       })
  //       .build();

  //     expect(definition.baseServices).toBeDefined();

  //     // Get implicit deps first
  //     const deps = definition.dependencies!({
  //       config: {},
  //       options: { databaseAdapter: mockAdapter },
  //     });

  //     const services = definition.baseServices!({
  //       config: {},
  //       options: { databaseAdapter: mockAdapter },
  //       deps,
  //       serviceDeps: {},
  //       defineService: (svc) => svc,
  //     });

  //     expect(services.getUsers()).toBe("function");
  //   });
  // });
});
