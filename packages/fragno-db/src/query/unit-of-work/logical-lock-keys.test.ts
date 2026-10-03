import { describe, expect, it } from "vitest";

import { column, idColumn, schema } from "../../schema/create";
import { FragnoId } from "../../schema/create";
import { deriveLogicalLockKeys } from "./logical-lock-keys";

const testSchema = schema("lock_keys_suite", (s) =>
  s.addTable("users", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("email", column("string"))
      .addColumn("name", column("string").nullable())
      .createIndex("users_email_idx", ["email"], { unique: true }),
  ),
);

describe("deriveLogicalLockKeys", () => {
  it("maps primary checkAbsent to the same key as create", () => {
    const createKeys = deriveLogicalLockKeys([
      {
        type: "create",
        schema: testSchema,
        namespace: "ns",
        table: "users",
        values: { id: "user-1", email: "a@example.com" },
        generatedExternalId: "user-1",
      },
    ]);
    const absentKeys = deriveLogicalLockKeys([
      {
        type: "check-absent",
        schema: testSchema,
        namespace: "ns",
        table: "users",
        indexName: "primary",
        values: { id: "user-1" },
      },
    ]);
    expect(absentKeys).toHaveLength(1);
    expect(createKeys).toContain(absentKeys[0]);
  });

  it("overlaps checkAbsent and create on the same unique index", () => {
    const createKeys = deriveLogicalLockKeys([
      {
        type: "create",
        schema: testSchema,
        namespace: "ns",
        table: "users",
        values: { id: "user-1", email: "a@example.com" },
        generatedExternalId: "user-1",
      },
    ]);
    const absentKeys = deriveLogicalLockKeys([
      {
        type: "check-absent",
        schema: testSchema,
        namespace: "ns",
        table: "users",
        indexName: "users_email_idx",
        values: { email: "a@example.com" },
      },
    ]);
    expect(absentKeys).toHaveLength(1);
    expect(createKeys).toContain(absentKeys[0]);
  });

  it("sorts and dedupes keys for deadlock-safe acquisition", () => {
    const first = deriveLogicalLockKeys([
      {
        type: "check",
        schema: testSchema,
        namespace: "ns",
        table: "users",
        id: FragnoId.fromExternal("user-b", 0),
      },
      {
        type: "check",
        schema: testSchema,
        namespace: "ns",
        table: "users",
        id: FragnoId.fromExternal("user-a", 0),
      },
      {
        type: "check",
        schema: testSchema,
        namespace: "ns",
        table: "users",
        id: FragnoId.fromExternal("user-a", 0),
      },
    ]);
    expect(first).toHaveLength(2);
    expect([...first].sort()).toEqual(first);
  });
});
