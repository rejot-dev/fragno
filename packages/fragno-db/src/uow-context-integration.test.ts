import { describe, it, expect } from "vitest";
import { defineFragmentWithDatabase } from "./fragment";
import { createFragment } from "@fragno-dev/core";
import { schema, column, idColumn } from "./schema/create";

describe("UOW Context Integration", () => {
  it("should bind services to use serviceContext", () => {
    // Create a schema
    const testSchema = schema((s) => {
      return s.addTable("user", (t) => {
        return t.addColumn("id", idColumn()).addColumn("name", column("string"));
      });
    });

    // Define fragment with service that uses this.getUnitOfWork()
    const fragmentDef = defineFragmentWithDatabase<{}>("test-fragment")
      .withDatabase(testSchema, "test")
      .providesService(({ defineService }) =>
        defineService({
          createUser: function (name: string) {
            const uow = this.getUnitOfWork(testSchema);
            const userId = uow.create("user", { name });
            return { userId: userId.valueOf(), name };
          },
        }),
      );

    // Mock database adapter
    const mockSchemaView = {
      create: () => ({ valueOf: () => 1 }),
    };
    const mockUow = {
      forSchema: () => mockSchemaView,
    };
    const mockAdapter = {
      createQueryEngine: () => ({
        createUnitOfWork: () => mockUow,
      }),
    };

    // Create fragment instance - services should be bound
    const fragment = createFragment(fragmentDef, {}, [], {
      mountRoute: "/api/test",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      databaseAdapter: mockAdapter as any,
    });

    // Verify services are defined
    expect(fragment.services).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((fragment.services as any).createUser).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(typeof (fragment.services as any).createUser).toBe("function");
  });

  it("should bind providesService services properly", () => {
    const schema1 = schema((s) => {
      return s.addTable("post", (t) => {
        return t.addColumn("id", idColumn()).addColumn("title", column("string"));
      });
    });

    // Fragment with providesService
    const fragmentDef = defineFragmentWithDatabase<{}>("fragment1")
      .withDatabase(schema1, "fragment1")
      .providesService(({ defineService }) =>
        defineService({
          createPost: function (title: string) {
            const uow = this.getUnitOfWork(schema1);
            const postId = uow.create("post", { title });
            return { postId: postId.valueOf(), title };
          },
        }),
      );

    // Mock adapter
    const mockSchemaView = {
      create: () => ({ valueOf: () => 2 }),
    };
    const mockUow = {
      forSchema: () => mockSchemaView,
    };
    const mockAdapter = {
      createQueryEngine: () => ({
        createUnitOfWork: () => mockUow,
      }),
    };

    // Create fragment
    const fragment = createFragment(fragmentDef, {}, [], {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      databaseAdapter: mockAdapter as any,
    });

    // Verify service is properly bound
    expect(fragment.services).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((fragment.services as any).createPost).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(typeof (fragment.services as any).createPost).toBe("function");
  });
});
