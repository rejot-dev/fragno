import { describe, it, expect } from "vitest";
import { bindServicesToContext } from "./bind-services";
import { withUnitOfWork, type DatabaseRequestThisContext } from "./fragment";
import type { IUnitOfWorkBase } from "./query/unit-of-work";
import { schema, idColumn } from "./schema/create";

// Create a simple test schema for tests
const testSchema = schema((s) => {
  return s.addTable("test", (t) => {
    return t.addColumn("id", idColumn());
  });
});

describe("bindServicesToContext", () => {
  it("should bind simple function to context", async () => {
    const mockSchemaView = { test: "schema-view" };
    const mockUow = {
      test: "uow",
      forSchema: () => mockSchemaView,
    } as unknown as IUnitOfWorkBase;

    const services = {
      testMethod: function (this: DatabaseRequestThisContext) {
        return this.getUnitOfWork(testSchema);
      },
    };

    const bound = bindServicesToContext(services);

    const result = await withUnitOfWork(mockUow, () => bound.testMethod());

    expect(result).toBe(mockSchemaView);
  });

  it("should bind multiple functions", async () => {
    const mockSchemaView = { test: "schema-view" };
    const mockUow = {
      test: "uow",
      forSchema: () => mockSchemaView,
    } as unknown as IUnitOfWorkBase;

    const services = {
      method1: function (this: DatabaseRequestThisContext) {
        return this.getUnitOfWork(testSchema);
      },
      method2: function (this: DatabaseRequestThisContext) {
        return this.getUnitOfWork(testSchema);
      },
    };

    const bound = bindServicesToContext(services);

    await withUnitOfWork(mockUow, () => {
      expect(bound.method1()).toBe(mockSchemaView);
      expect(bound.method2()).toBe(mockSchemaView);
    });
  });

  it("should bind nested service objects", async () => {
    const mockSchemaView = { test: "schema-view" };
    const mockUow = {
      test: "uow",
      forSchema: () => mockSchemaView,
    } as unknown as IUnitOfWorkBase;

    const services = {
      nested: {
        method: function (this: DatabaseRequestThisContext) {
          return this.getUnitOfWork(testSchema);
        },
      },
    };

    const bound = bindServicesToContext(services);

    const result = await withUnitOfWork(mockUow, () => bound.nested.method());

    expect(result).toBe(mockSchemaView);
  });

  it("should preserve non-function properties", () => {
    const services = {
      method: function () {
        return "test";
      },
      constant: "value",
      number: 42,
    };

    const bound = bindServicesToContext(services);

    expect(bound.constant).toBe("value");
    expect(bound.number).toBe(42);
    expect(bound.method()).toBe("test");
  });

  it("should handle functions with parameters", async () => {
    const mockSchemaView = { test: "schema-view" };
    const mockUow = {
      test: "uow",
      forSchema: () => mockSchemaView,
    } as unknown as IUnitOfWorkBase;

    const services = {
      testMethod: function (this: DatabaseRequestThisContext, param1: string, param2: number) {
        const uow = this.getUnitOfWork(testSchema);
        return { uow, param1, param2 };
      },
    };

    const bound = bindServicesToContext(services);

    const result = await withUnitOfWork(mockUow, () => bound.testMethod("hello", 123));

    expect(result.uow).toBe(mockSchemaView);
    expect(result.param1).toBe("hello");
    expect(result.param2).toBe(123);
  });

  it("should handle async functions", async () => {
    const mockSchemaView = { test: "schema-view" };
    const mockUow = {
      test: "uow",
      forSchema: () => mockSchemaView,
    } as unknown as IUnitOfWorkBase;

    const services = {
      asyncMethod: async function (this: DatabaseRequestThisContext) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return this.getUnitOfWork(testSchema);
      },
    };

    const bound = bindServicesToContext(services);

    const result = await withUnitOfWork(mockUow, async () => await bound.asyncMethod());

    expect(result).toBe(mockSchemaView);
  });

  it("should not bind arrays", () => {
    const services = {
      array: [1, 2, 3],
      method: function () {
        return "test";
      },
    };

    const bound = bindServicesToContext(services);

    expect(bound.array).toEqual([1, 2, 3]);
    expect(Array.isArray(bound.array)).toBe(true);
  });

  it("should handle deeply nested objects", async () => {
    const mockSchemaView = { test: "schema-view" };
    const mockUow = {
      test: "uow",
      forSchema: () => mockSchemaView,
    } as unknown as IUnitOfWorkBase;

    const services = {
      level1: {
        level2: {
          level3: {
            method: function (this: DatabaseRequestThisContext) {
              return this.getUnitOfWork(testSchema);
            },
          },
        },
      },
    };

    const bound = bindServicesToContext(services);

    const result = await withUnitOfWork(mockUow, () => bound.level1.level2.level3.method());

    expect(result).toBe(mockSchemaView);
  });

  it("should allow bound services to access UOW independently", async () => {
    const mockSchemaView = { test: "schema-view" };
    const mockUow = {
      test: "uow",
      forSchema: () => mockSchemaView,
    } as unknown as IUnitOfWorkBase;

    const services = {
      getUow: function (this: DatabaseRequestThisContext) {
        return this.getUnitOfWork(testSchema);
      },
      callOther: function (this: DatabaseRequestThisContext) {
        // Both methods can access UOW via their own `this` context
        return this.getUnitOfWork(testSchema);
      },
    };

    const bound = bindServicesToContext(services);

    await withUnitOfWork(mockUow, () => {
      expect(bound.getUow()).toBe(mockSchemaView);
      expect(bound.callOther()).toBe(mockSchemaView);
    });
  });
});
