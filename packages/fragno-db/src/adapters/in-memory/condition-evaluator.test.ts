import { describe, it, assert } from "vitest";

import type { Condition } from "../../query/condition-builder";
import { buildCondition } from "../../query/condition-builder";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import { evaluateCondition } from "./condition-evaluator";
import { createNamespaceStore } from "./store";

describe("in-memory condition evaluator", () => {
  it("evaluates SQLite-normalized comparisons and LIKE semantics", () => {
    const testSchema = schema("test", (s) =>
      s.addTable("events", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("createdAt", column("timestamp"))
          .addColumn("isActive", column("bool"))
          .addColumn("payload", column("json"))
          .addColumn("size", column("bigint")),
      ),
    );

    const table = testSchema.tables.events;
    const createdAt = new Date("2024-01-01T00:00:00.000Z");
    const payload = { ok: true, count: 2 };
    const row = {
      id: "evt_1",
      name: "Test User",
      createdAt,
      isActive: true,
      payload,
      size: 9n,
    };

    assert(
      evaluateCondition(
        buildCondition(table.columns, (eb) => eb("createdAt", "=", createdAt)),
        table,
        row,
      ),
    );
    const numericBooleanCondition: Condition = {
      type: "compare",
      a: table.columns.isActive,
      operator: "=",
      b: 1,
    };
    assert(evaluateCondition(numericBooleanCondition, table, row));
    assert(
      evaluateCondition(
        buildCondition(table.columns, (eb) => eb("payload", "=", payload)),
        table,
        row,
      ),
    );
    assert(
      evaluateCondition(
        buildCondition(table.columns, (eb) => eb("size", ">", 8n)),
        table,
        row,
      ),
    );
    assert(
      evaluateCondition(
        buildCondition(table.columns, (eb) => eb("name", "contains", "test")),
        table,
        row,
      ),
    );
    assert(
      evaluateCondition(
        buildCondition(table.columns, (eb) => eb("name", "starts with", "TEST")),
        table,
        row,
      ),
    );
    assert(
      evaluateCondition(
        buildCondition(table.columns, (eb) => eb("name", "ends with", "user")),
        table,
        row,
      ),
    );
  });

  it("handles null and IN semantics", () => {
    const testSchema = schema("test", (s) =>
      s.addTable("events", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("age", column("integer").nullable())
          .addColumn("size", column("bigint")),
      ),
    );

    const table = testSchema.tables.events;
    const row = {
      id: "evt_2",
      age: null,
      size: 9n,
    };

    assert(
      evaluateCondition(
        buildCondition(table.columns, (eb) => eb("age", "is", null)),
        table,
        row,
      ),
    );
    assert(
      !evaluateCondition(
        buildCondition(table.columns, (eb) => eb("age", "=", null)),
        table,
        row,
      ),
    );
    assert(
      !evaluateCondition(
        buildCondition(table.columns, (eb) => eb("age", "is not", null)),
        table,
        row,
      ),
    );

    const inCondition: Condition = {
      type: "compare",
      a: table.columns.size,
      operator: "in",
      b: [1n, null],
    };
    const notInCondition: Condition = {
      type: "compare",
      a: table.columns.size,
      operator: "not in",
      b: [1n, null],
    };

    assert(!evaluateCondition(inCondition, table, row));
    assert(!evaluateCondition(notInCondition, table, row));
    assert(
      evaluateCondition(
        buildCondition(table.columns, (eb) => eb("size", "not in", [1n, 2n])),
        table,
        row,
      ),
    );
  });

  it("resolves reference values against the namespace store", () => {
    const refSchema = schema("ref", (s) =>
      s
        .addTable("users", (t) =>
          t.addColumn("id", idColumn()).addColumn("email", column("string")),
        )
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("title", column("string"))
            .addColumn("userId", referenceColumn({ table: "users" })),
        ),
    );

    const namespaceStore = createNamespaceStore(refSchema);
    const usersStore = namespaceStore.tables.get("users");
    const postsTable = refSchema.tables.posts;

    if (!usersStore) {
      throw new Error("users table missing from namespace store");
    }

    usersStore.rows.set(1n, {
      id: "user_1",
      email: "user@example.com",
      _internalId: 1n,
      _version: 0,
    });

    const postRow = {
      id: "post_1",
      title: "Hello",
      userId: 1n,
      _internalId: 10n,
      _version: 0,
    };

    const condition = buildCondition(postsTable.columns, (eb) => eb("userId", "=", "user_1"));
    assert(evaluateCondition(condition, postsTable, postRow, namespaceStore));
  });
});
