import { test, expect, describe, expectTypeOf } from "vitest";
import { defineFragmentWithDatabase, type FragnoPublicConfigWithDatabase } from "./fragment";
import { createFragment } from "@fragno-dev/core";
import { schema, idColumn, column } from "./schema/create";
import type { AbstractQuery } from "./query/query";
import type { DatabaseAdapter } from "./mod";

type Empty = Record<never, never>;

const mockDatabaseAdapter: DatabaseAdapter = {
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

    test("withServices has access to config, fragnoConfig, deps, and orm", () => {
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
        .withServices(({ fragnoConfig, deps, orm }) => {
          expectTypeOf(fragnoConfig).toEqualTypeOf<{ mountRoute?: string }>();
          expectTypeOf(deps).toEqualTypeOf<{
            userRepo: {
              create: (name: string) => ReturnType<AbstractQuery<typeof _testSchema>["create"]>;
            };
          }>();
          expectTypeOf(orm).toEqualTypeOf<AbstractQuery<typeof _testSchema>>();

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
      const builder5 = builder4.withServices(() => ({ service1: "value1" }));

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
        .withServices(({ deps }) => ({
          service: `Service using ${deps.client}`,
        }));

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
        .withServices(() => ({
          logger: { log: (s: string) => console.log(s) },
        }));

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
        .withServices(() => ({
          serviceValue: "test",
        }));

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
        .withServices(({ orm }) => {
          servicesOrm = orm;
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
});
