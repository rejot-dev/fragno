import { describe, it, expect } from "vitest";
import { schema, idColumn, column, FragnoId } from "../../schema/create";
import { UnitOfWorkDecoder } from "./uow-decoder";
import { SQLocalDriverConfig } from "./driver-config";
import type { RetrievalOperation } from "../../query/unit-of-work/unit-of-work";
import type { AnySchema } from "../../schema/create";

describe("UnitOfWorkDecoder", () => {
  const driverConfig = new SQLocalDriverConfig();

  const testSchema = schema((s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("email", column("string"))
          .addColumn("age", column("integer").nullable())
          .createIndex("idx_email", ["email"], { unique: true });
      })
      .addTable("posts", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("title", column("string"))
          .addColumn("content", column("string"))
          .createIndex("idx_title", ["title"]);
      });
  });

  const decoder = new UnitOfWorkDecoder(driverConfig);

  describe("decode", () => {
    it("should decode regular find operations", () => {
      const operation: RetrievalOperation<AnySchema> = {
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "_primary",
        options: {
          useIndex: "_primary",
        },
      };

      const rawResults = [
        [
          { id: "user1", name: "Alice", email: "alice@example.com", age: 30 },
          { id: "user2", name: "Bob", email: "bob@example.com", age: null },
        ],
      ];

      const results = decoder.decode(rawResults, [operation]);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual([
        { id: "user1", name: "Alice", email: "alice@example.com", age: 30 },
        { id: "user2", name: "Bob", email: "bob@example.com", age: null },
      ]);
    });

    it("should decode count operations", () => {
      const operation: RetrievalOperation<AnySchema> = {
        type: "count",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "_primary",
        options: {
          useIndex: "_primary",
        },
      };

      const rawResults = [[{ count: 42 }]];

      const results = decoder.decode(rawResults, [operation]);

      expect(results).toHaveLength(1);
      expect(results[0]).toBe(42);
    });

    it("should decode cursor-paginated operations", () => {
      const operation: RetrievalOperation<AnySchema> = {
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "_primary",
        options: {
          useIndex: "_primary",
          pageSize: 2,
          orderByIndex: {
            indexName: "_primary",
            direction: "asc",
          },
        },
        withCursor: true,
      };

      // Fetch pageSize + 1 to detect hasNextPage
      const rawResults = [
        [
          { id: "user1", name: "Alice", email: "alice@example.com", age: 30 },
          { id: "user2", name: "Bob", email: "bob@example.com", age: 25 },
          { id: "user3", name: "Charlie", email: "charlie@example.com", age: 35 },
        ],
      ];

      const results = decoder.decode(rawResults, [operation]);

      expect(results).toHaveLength(1);
      const cursorResult = results[0] as {
        items: unknown[];
        cursor?: unknown;
        hasNextPage: boolean;
      };

      expect(cursorResult.items).toHaveLength(2);
      expect(cursorResult.items).toEqual([
        { id: "user1", name: "Alice", email: "alice@example.com", age: 30 },
        { id: "user2", name: "Bob", email: "bob@example.com", age: 25 },
      ]);
      expect(cursorResult.hasNextPage).toBe(true);
      expect(cursorResult.cursor).toBeDefined();
    });

    it("should decode cursor-paginated operations without hasNextPage when exactly pageSize rows", () => {
      const operation: RetrievalOperation<AnySchema> = {
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "_primary",
        options: {
          useIndex: "_primary",
          pageSize: 2,
          orderByIndex: {
            indexName: "_primary",
            direction: "asc",
          },
        },
        withCursor: true,
      };

      const rawResults = [
        [
          { id: "user1", name: "Alice", email: "alice@example.com", age: 30 },
          { id: "user2", name: "Bob", email: "bob@example.com", age: 25 },
        ],
      ];

      const results = decoder.decode(rawResults, [operation]);

      expect(results).toHaveLength(1);
      const cursorResult = results[0] as {
        items: unknown[];
        cursor?: unknown;
        hasNextPage: boolean;
      };

      expect(cursorResult.items).toHaveLength(2);
      expect(cursorResult.hasNextPage).toBe(false);
      expect(cursorResult.cursor).toBeUndefined();
    });

    it("should decode multiple operations", () => {
      const findOperation: RetrievalOperation<AnySchema> = {
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "_primary",
        options: {
          useIndex: "_primary",
        },
      };

      const countOperation: RetrievalOperation<AnySchema> = {
        type: "count",
        schema: testSchema,
        table: testSchema.tables.posts,
        indexName: "_primary",
        options: {
          useIndex: "_primary",
        },
      };

      const rawResults = [
        [{ id: "user1", name: "Alice", email: "alice@example.com", age: 30 }],
        [{ count: 5 }],
      ];

      const results = decoder.decode(rawResults, [findOperation, countOperation]);

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual([
        { id: "user1", name: "Alice", email: "alice@example.com", age: 30 },
      ]);
      expect(results[1]).toBe(5);
    });

    it("should throw error when rawResults and operations lengths don't match", () => {
      const operation: RetrievalOperation<AnySchema> = {
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "_primary",
        options: {
          useIndex: "_primary",
        },
      };

      const rawResults = [[{ id: "user1", name: "Alice" }], [{ id: "user2", name: "Bob" }]];

      expect(() => decoder.decode(rawResults, [operation])).toThrow(
        "rawResults and ops must have the same length",
      );
    });

    it("should handle empty results for regular find", () => {
      const operation: RetrievalOperation<AnySchema> = {
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "_primary",
        options: {
          useIndex: "_primary",
        },
      };

      const rawResults = [[]];

      const results = decoder.decode(rawResults, [operation]);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual([]);
    });

    it("should handle count result with no rows", () => {
      const operation: RetrievalOperation<AnySchema> = {
        type: "count",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "_primary",
        options: {
          useIndex: "_primary",
        },
      };

      const rawResults = [[]];

      const results = decoder.decode(rawResults, [operation]);

      expect(results).toHaveLength(1);
      expect(results[0]).toBe(0);
    });

    it("should generate cursor for custom index", () => {
      const operation: RetrievalOperation<AnySchema> = {
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "idx_email",
        options: {
          useIndex: "idx_email",
          pageSize: 1,
          orderByIndex: {
            indexName: "idx_email",
            direction: "asc",
          },
        },
        withCursor: true,
      };

      const rawResults = [
        [
          { id: "user1", name: "Alice", email: "alice@example.com", age: 30 },
          { id: "user2", name: "Bob", email: "bob@example.com", age: 25 },
        ],
      ];

      const results = decoder.decode(rawResults, [operation]);

      expect(results).toHaveLength(1);
      const cursorResult = results[0] as {
        items: unknown[];
        cursor?: unknown;
        hasNextPage: boolean;
      };

      expect(cursorResult.items).toHaveLength(1);
      expect(cursorResult.hasNextPage).toBe(true);
      expect(cursorResult.cursor).toBeDefined();
    });

    it("should handle cursor pagination without orderByIndex", () => {
      const operation: RetrievalOperation<AnySchema> = {
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "_primary",
        options: {
          useIndex: "_primary",
          pageSize: 2,
        },
        withCursor: true,
      };

      const rawResults = [
        [
          { id: "user1", name: "Alice", email: "alice@example.com", age: 30 },
          { id: "user2", name: "Bob", email: "bob@example.com", age: 25 },
          { id: "user3", name: "Charlie", email: "charlie@example.com", age: 35 },
        ],
      ];

      const results = decoder.decode(rawResults, [operation]);

      expect(results).toHaveLength(1);
      const cursorResult = results[0] as {
        items: unknown[];
        cursor?: unknown;
        hasNextPage: boolean;
      };

      expect(cursorResult.items).toHaveLength(2);
      expect(cursorResult.hasNextPage).toBe(true);
      expect(cursorResult.cursor).toBeUndefined(); // No cursor when orderByIndex is missing
    });

    it("should throw error for invalid count value", () => {
      const operation: RetrievalOperation<AnySchema> = {
        type: "count",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "_primary",
        options: {
          useIndex: "_primary",
        },
      };

      const rawResults = [[{ count: "invalid" }]];

      expect(() => decoder.decode(rawResults, [operation])).toThrow(
        "Unexpected result for count, received: NaN",
      );
    });

    it("should handle cursor pagination with FragnoId in cursor", () => {
      const operation: RetrievalOperation<AnySchema> = {
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "_primary",
        options: {
          useIndex: "_primary",
          pageSize: 1,
          orderByIndex: {
            indexName: "_primary",
            direction: "asc",
          },
        },
        withCursor: true,
      };

      const rawResults = [
        [
          {
            id: "user1",
            _internalId: BigInt(123),
            _version: 1,
            name: "Alice",
            email: "alice@example.com",
            age: 30,
          },
          {
            id: "user2",
            _internalId: BigInt(456),
            _version: 1,
            name: "Bob",
            email: "bob@example.com",
            age: 25,
          },
        ],
      ];

      const results = decoder.decode(rawResults, [operation]);

      expect(results).toHaveLength(1);
      const cursorResult = results[0] as {
        items: unknown[];
        cursor?: unknown;
        hasNextPage: boolean;
      };

      expect(cursorResult.items).toHaveLength(1);
      expect(cursorResult.hasNextPage).toBe(true);
      expect(cursorResult.cursor).toBeDefined();

      // Verify the item has FragnoId
      const firstItem = cursorResult.items[0] as Record<string, unknown>;
      expect(firstItem["id"]).toBeInstanceOf(FragnoId);
    });
  });
});
