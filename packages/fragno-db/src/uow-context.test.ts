import { describe, it, expect } from "vitest";
import { uowStorage, serviceContext, withUnitOfWork } from "./fragment";
import type { IUnitOfWorkBase } from "./query/unit-of-work";
import { schema, idColumn } from "./schema/create";

// Create a simple test schema for tests
const testSchema = schema((s) => {
  return s.addTable("test", (t) => {
    return t.addColumn("id", idColumn());
  });
});

describe("UOW Context", () => {
  describe("serviceContext.getUnitOfWork", () => {
    it("should throw error when called outside context", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => serviceContext.getUnitOfWork(testSchema as any)).toThrow(
        "No UnitOfWork in context. Service must be called within a route handler.",
      );
    });

    it("should return scoped UOW when called inside withUnitOfWork", async () => {
      const mockSchemaView = { test: "schema-view" };
      const mockUow = {
        test: "uow",
        forSchema: () => mockSchemaView,
      } as unknown as IUnitOfWorkBase;

      await withUnitOfWork(mockUow, () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const uow = serviceContext.getUnitOfWork(testSchema as any);
        expect(uow).toBe(mockSchemaView);
      });
    });

    it("should allow nested withUnitOfWork calls", async () => {
      const view1 = { id: 1 };
      const view2 = { id: 2 };
      const uow1 = {
        id: 1,
        forSchema: () => view1,
      } as unknown as IUnitOfWorkBase;
      const uow2 = {
        id: 2,
        forSchema: () => view2,
      } as unknown as IUnitOfWorkBase;

      await withUnitOfWork(uow1, async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(serviceContext.getUnitOfWork(testSchema as any)).toBe(view1);

        await withUnitOfWork(uow2, () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          expect(serviceContext.getUnitOfWork(testSchema as any)).toBe(view2);
        });

        // Should be back to uow1 after nested context
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(serviceContext.getUnitOfWork(testSchema as any)).toBe(view1);
      });
    });

    it("should isolate UOW between parallel async calls", async () => {
      const view1 = { id: 1 };
      const view2 = { id: 2 };
      const uow1 = {
        id: 1,
        forSchema: () => view1,
      } as unknown as IUnitOfWorkBase;
      const uow2 = {
        id: 2,
        forSchema: () => view2,
      } as unknown as IUnitOfWorkBase;

      const promise1 = withUnitOfWork(uow1, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return serviceContext.getUnitOfWork(testSchema as any);
      });

      const promise2 = withUnitOfWork(uow2, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return serviceContext.getUnitOfWork(testSchema as any);
      });

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1).toBe(view1);
      expect(result2).toBe(view2);
    });
  });

  describe("uowStorage", () => {
    it("should return undefined when no UOW is stored", () => {
      const stored = uowStorage.getStore();
      expect(stored).toBeUndefined();
    });

    it("should store and retrieve UOW", async () => {
      const mockUow = { test: "uow" } as unknown as IUnitOfWorkBase;

      await withUnitOfWork(mockUow, () => {
        const stored = uowStorage.getStore();
        expect(stored).toBe(mockUow);
      });

      // Should be undefined after exiting context
      const stored = uowStorage.getStore();
      expect(stored).toBeUndefined();
    });
  });

  describe("withUnitOfWork", () => {
    it("should execute callback with UOW in context", async () => {
      const mockSchemaView = { test: "schema-view" };
      const mockUow = {
        test: "uow",
        forSchema: () => mockSchemaView,
      } as unknown as IUnitOfWorkBase;
      let called = false;

      await withUnitOfWork(mockUow, () => {
        called = true;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(serviceContext.getUnitOfWork(testSchema as any)).toBe(mockSchemaView);
      });

      expect(called).toBe(true);
    });

    it("should return callback result", async () => {
      const mockUow = { test: "uow" } as unknown as IUnitOfWorkBase;
      const result = await withUnitOfWork(mockUow, () => "test-result");

      expect(result).toBe("test-result");
    });

    it("should handle async callbacks", async () => {
      const mockUow = { test: "uow" } as unknown as IUnitOfWorkBase;

      const result = await withUnitOfWork(mockUow, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return "async-result";
      });

      expect(result).toBe("async-result");
    });

    it("should propagate errors from callback", async () => {
      const mockUow = { test: "uow" } as unknown as IUnitOfWorkBase;

      let error: Error | null = null;
      try {
        await withUnitOfWork(mockUow, () => {
          throw new Error("test error");
        });
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toBe("test error");
    });

    it("should clean up context after error", async () => {
      const mockUow = { test: "uow" } as unknown as IUnitOfWorkBase;

      try {
        await withUnitOfWork(mockUow, () => {
          throw new Error("test error");
        });
      } catch {
        // Expected error
      }

      // UOW should no longer be in context
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => serviceContext.getUnitOfWork(testSchema as any)).toThrow();
    });
  });
});
