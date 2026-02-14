import { describe, expect, it } from "vitest";
import { column, idColumn, schema } from "../schema/create";
import {
  buildInternalMigrationOperations,
  resolveInternalMigrationRange,
  type InternalMigration,
} from "./internal-migrations";

describe("buildInternalMigrationOperations", () => {
  const testSchema = schema("test", (s) => {
    return s.addTable("users", (t) => {
      return t.addColumn("id", idColumn()).addColumn("name", column("string"));
    });
  });

  const context = {
    schema: testSchema,
    namespace: "test",
  };

  it("filters empty statements and slices by version", () => {
    const migrations: InternalMigration[] = [
      () => "select 1",
      () => ["", "  ", "select 2"],
      () => undefined,
      () => "select 3",
    ];

    const operations = buildInternalMigrationOperations(migrations, context, 1, 3);

    expect(operations).toHaveLength(1);
    expect(operations[0]).toEqual({ type: "custom", sql: "select 2" });
  });

  it("returns empty array when fromVersion equals toVersion", () => {
    const migrations: InternalMigration[] = [() => "select 1"];

    const operations = buildInternalMigrationOperations(migrations, context, 1, 1);

    expect(operations).toEqual([]);
  });
});

describe("resolveInternalMigrationRange", () => {
  it("returns null when internalFromVersion is undefined", () => {
    const result = resolveInternalMigrationRange([], undefined);

    expect(result).toBeNull();
  });

  it("throws when internalToVersion is provided without internalFromVersion", () => {
    expect(() => resolveInternalMigrationRange([], undefined, 1)).toThrow(
      "internalToVersion requires internalFromVersion.",
    );
  });

  it("defaults to migrations length when internalToVersion is omitted", () => {
    const result = resolveInternalMigrationRange([() => "select 1"], 0);

    expect(result).toEqual({ fromVersion: 0, toVersion: 1 });
  });
});
