import { describe, it, expect } from "vitest";
import { defineFragment, instantiate } from "@fragno-dev/core";
import { schema, column, idColumn } from "./schema/create";
import { withDatabase } from "./db-fragment-definition-builder";

describe("UOW Context Integration", () => {
  it("should bind services to use serviceContext", () => {
    // Create a schema
    const testSchema = schema((s) => {
      return s.addTable("user", (t) => {
        return t.addColumn("id", idColumn()).addColumn("name", column("string"));
      });
    });

    // Define fragment with service that uses this.getUnitOfWork()
    const fragmentDef = defineFragment<{}>("test-fragment")
      .extend(withDatabase(testSchema))
      .providesBaseService(({ defineService }) =>
        defineService({
          createUser: function (name: string) {
            const uow = this.getUnitOfWork(testSchema);
            const userId = uow.create("user", { name });
            return { userId: userId.valueOf(), name };
          },
        }),
      )
      .build();

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
    const fragment = instantiate(fragmentDef)
      .withConfig({})
      .withOptions({
        mountRoute: "/api/test",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        databaseAdapter: mockAdapter as any,
      })
      .build();

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
    const fragmentDef = defineFragment<{}>("fragment1")
      .extend(withDatabase(schema1))
      .providesBaseService(({ defineService }) =>
        defineService({
          createPost: function (title: string) {
            const uow = this.getUnitOfWork(schema1);
            const postId = uow.create("post", { title });
            return { postId: postId.valueOf(), title };
          },
        }),
      )
      .build();

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
    const fragment = instantiate(fragmentDef)
      .withConfig({})
      .withOptions({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        databaseAdapter: mockAdapter as any,
      })
      .build();

    // Verify service is properly bound
    expect(fragment.services).toBeDefined();
    expect(fragment.services.createPost).toBeDefined();
    expect(typeof fragment.services.createPost).toBe("function");
  });
});
